import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry, createWorkspaceChatTools, createToolManifests, toolSchemaToZod, createToolPreview } from '../src/index'

describe('host tool extensions', () => {
  it('exposes a Janus-only tool through the manifest without adding its name to the engine', async () => {
    const registry = new ToolRegistry()
    registry.register({ name: 'blueprint.focus', actionRisk: 'read', description: 'Focus nodes',
      inputSchema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, rank: { type: 'integer' }, label: { type: ['string', 'null'] } }, required: ['id', 'rank'], additionalProperties: false } } }, required: ['nodes'], additionalProperties: false }, execute: () => undefined })
    const execute = vi.fn(async () => ({ status: 'completed', output: { focused: true } }) as any)
    const tools = createWorkspaceChatTools({ runtime: { executeFunctionCall: execute }, callerId: 'host', resources: new Map([['w', { sessionId: 's', workspaceRoot: '/w', workspaceName: 'W' }]]), toolManifests: createToolManifests(registry.list()) })
    const tool = tools.blueprint_focus
    expect(tool.parameters.safeParse({ nodes: [{ id: 'n', rank: 1.5 }] }).success).toBe(false)
    expect(tool.parameters.safeParse({ nodes: [{ id: 'n', rank: 1, label: null }] }).success).toBe(true)
    await tool.execute({ nodes: [{ id: 'n', rank: 1 }] })
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 's', call: { toolName: 'blueprint.focus', input: { workspaceId: 'w' } } })
    await tool.execute({ workspaceId: 'other', nodes: [] })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects provider-name collisions and validates nested maps and enums', () => {
    const registry = new ToolRegistry()
    const definition = { actionRisk: 'read' as const, description: 'host', inputSchema: { type: 'object' as const }, execute() {} }
    registry.register({ ...definition, name: 'host.focus' })
    expect(() => registry.register({ ...definition, name: 'host_focus' })).toThrow('collision')
    const schema = toolSchemaToZod({ type: 'object', properties: { values: { type: 'object', additionalProperties: { type: 'string', enum: ['target', 'reference'] } } }, required: ['values'], additionalProperties: false })
    expect(schema.safeParse({ values: { node: 'target' } }).success).toBe(true)
    expect(schema.safeParse({ values: { node: 'unknown' } }).success).toBe(false)
    expect(() => toolSchemaToZod({ type: 'date' })).toThrow('Unsupported')
    expect(createToolPreview('mcp.example', { token: 'secret', path: '' })).toMatchObject({ summary: 'mcp.example', truncated: false })
  })
})
