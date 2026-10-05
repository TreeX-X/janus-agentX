import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentRuntime, ToolRegistry, createToolPreview } from '@janus-agent/agent-core'
import { McpToolManager } from '../src/mcp.js'
const managers: McpToolManager[] = []
const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('shared MCP connections', () => {
  it('discovers and executes stdio tools and unregisters them on close', async () => {
    const registry = new ToolRegistry(); const manager = new McpToolManager(registry); managers.push(manager)
    await manager.connect({ mcpServers: { fixture: { command: process.execPath, args: [fixture] }, disabled: { command: 'unused', disabled: true } } })
    expect(manager.status).toEqual([{ server: 'fixture', state: 'connected', tools: 2 }, { server: 'disabled', state: 'disabled', tools: 0 }])
    const echo = registry.list().find(tool => tool.name.includes('.echo_'))!
    expect(echo.actionRisk).toBe('network')
    const input = { workspaceId: 'w', arguments: { text: 'hello' } }
    const tool = registry.validateCall({ toolName: echo.name, input })
    expect(await tool.execute(input, { workspaceId: 'w', workspaceRoot: '.', signal: new AbortController().signal })).toMatchObject({ content: [{ text: 'hello' }] })
    await manager.close()
    expect(registry.list()).toEqual([])
  }, 15000)
  it('retains runtime approval policy and cancels remote calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wfx-mcp-')); roots.push(root)
    const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => root })
    const manager = new McpToolManager(runtime.registry); managers.push(manager)
    await manager.connect({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } })
    const session = await runtime.createSession({ workspaceId: 'w', workspaceRoot: root, approvalMode: 'per-action' }, 'test')
    let approvals = 0
    runtime.onEvent(event => {
      if (event.type === 'approval-requested') { approvals++; runtime.resolveApproval({ ...event.request, approvalId: event.request.id, approved: false }, 'test') }
    })
    const echo = runtime.registry.list().find(tool => tool.name.includes('.echo_'))!
    const input = { workspaceId: 'w', arguments: { text: 'blocked' } }
    const denied = await runtime.executeTool({ sessionId: session.id, call: { toolName: echo.name, input, preview: createToolPreview(echo.name, input) } }, 'test')
    expect(approvals).toBe(1)
    expect(denied.status).not.toBe('completed')
    const wait = runtime.registry.list().find(tool => tool.name.includes('.wait_'))!
    const controller = new AbortController()
    const pending = runtime.registry.get(wait.name)!.execute({ workspaceId: 'w', arguments: {} }, { workspaceId: 'w', workspaceRoot: root, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    await runtime.cancelSession(session.id)
  }, 15000)
  it('reports failed configuration without leaking command environment', async () => {
    const manager = new McpToolManager(new ToolRegistry()); managers.push(manager)
    await manager.connect({ mcpServers: { broken: { command: 'nonexistent-wfx-test-command', env: { API_KEY: 'secret' } } } })
    expect(manager.status).toEqual([{ server: 'broken', state: 'failed', tools: 0 }])
    expect(JSON.stringify(manager.status)).not.toContain('secret')
  })
})
