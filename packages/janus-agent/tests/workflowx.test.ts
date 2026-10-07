import { describe, expect, it, vi } from 'vitest'
import { parseWorkflowXCommand, resolveWorkflowXMode } from '../src/workflowx.js'
import { WorkflowXCloseout } from '../src/workflowx-closeout.js'
import { runChatTurn } from '../src/orchestrator/chat-turn.js'
import type { ChatTurnPorts } from '../src/ports.js'
import type { ToolResult } from '@janus-agent/agent-core'

describe('built-in WorkflowX modes', () => {
  it('defaults to xdo and only takes slash commands from users', () => {
    expect(resolveWorkflowXMode([])).toBe('xdo')
    expect(parseWorkflowXCommand('/xflow implement\nthe task')).toEqual({ mode: 'xflow', prompt: 'implement\nthe task' })
    expect(parseWorkflowXCommand('/xflow-other')).toBeNull()
    expect(resolveWorkflowXMode([{ role: 'user', content: '/xdel' }, { role: 'assistant', content: '/xflow' }, { role: 'system', content: '/xdo' }])).toBe('xdel')
  })
  it('switches without contacting a model', async () => {
    const resolve = vi.fn(() => { throw new Error('no model') })
    const result = await runChatTurn({ requestId: 'r', providerId: '', messages: [{ role: 'user', content: '/xflow' }] }, { model: { resolve } } as unknown as ChatTurnPorts)
    expect(result.text).toBe('WorkflowX: xflow')
    expect(resolve).not.toHaveBeenCalled()
  })
  it('preserves a host-resolved mode after compaction and blocks direct delegated writes', async () => {
    let rounds = 0; const execute = vi.fn()
    const ports: ChatTurnPorts = {
      model: { resolve: async () => ({ model: {}, modelId: 'm' }), getMaxTurns: () => 2 },
      sessions: { getSession: () => ({ sessionId: 's', workspaceId: 'w', workspaceRoot: '/w', status: 'running' }) },
      tools: { executeFunctionCall: execute, registry: { list: () => [{ name: 'workspace.create', actionRisk: 'create', description: 'create', inputSchema: { type: 'object' } }] } },
      streamTextFn: async options => {
        expect(JSON.stringify(options.messages)).toContain('Current engineering mode: xflow')
        expect(options.tools).toHaveProperty('workflow_execute')
        return rounds++ === 0 ? { textStream: (async function* () {})(), fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'c', toolName: 'workspace_create', args: { path: 'a.ts', content: 'x' } }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })() } : { textStream: (async function* () { yield 'Use an accepted task.' })() }
      },
    }
    await runChatTurn({ requestId: 'r', providerId: 'p', sourceTag: 'janus-chat', workflowMode: 'xflow', messages: [{ role: 'user', content: 'continue' }], workspaceResources: [{ workspaceId: 'w', workspacePath: '/w', workspaceName: 'W', agentSessionId: 's' }] }, ports)
    expect(execute).not.toHaveBeenCalled()
  })
  it('reports missing xdo evidence and invalidates checks after another edit', () => {
    const audit = new WorkflowXCloseout()
    const record = (toolName: string, output = {}, input = {}) => audit.record({ toolName, status: 'completed', output } as ToolResult, input)
    record('workspace.edit', {}, { path: 'src/a.ts' })
    expect(audit.gaps()).toHaveLength(2)
    record('note.write', { status: 'applied' }); record('command.run', { ok: true, exitCode: 0 }); record('git.commit')
    expect(audit.gaps()).toEqual([])
    record('workspace.edit', {}, { path: 'src/b.ts' })
    expect(audit.gaps()).toHaveLength(2)
  })
})
