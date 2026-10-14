import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runChatTurn } from '../src/orchestrator/chat-turn'
import type { ChatTurnPorts } from '../src/ports'

function fixture() {
  const execute = vi.fn(async () => ({ content: 'Application memo read' }))
  const ports: ChatTurnPorts = {
    model: { resolve: async () => ({ model: {}, modelId: 'fixture' }), getMaxTurns: () => 3 },
    sessions: { getSession: () => null },
    tools: { registry: { list: () => [] }, executeFunctionCall: async () => { throw new Error('Unexpected workspace tool') } },
    localTools: [{ name: 'memo_read', description: 'Read an application memo', parameters: z.object({}).strict(), execute }],
    streamTextFn: async () => ({ textStream: (async function* () { yield 'Done' })() }),
  }
  return { ports, execute }
}
const request = { requestId: 'local', providerId: 'fixture', messages: [{ role: 'user' as const, content: 'Read my memo' }] }

describe('host local Chat tools', () => {
  it('offers and executes an application tool without a workspace', async () => {
    const { ports, execute } = fixture()
    let rounds = 0
    ports.streamTextFn = async options => {
      expect(Object.keys(options.tools as object)).toContain('memo_read')
      if (rounds++ === 0) return { textStream: (async function* () {})(), fullStream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'read', toolName: 'memo_read', args: {} }
        yield { type: 'finish', finishReason: 'tool-calls' }
      })() }
      return { textStream: (async function* () { yield 'Read' })() }
    }
    const result = await runChatTurn(request, ports)
    expect(execute).toHaveBeenCalledOnce()
    expect(result.text).toBe('Read')
    expect(result.toolTraces[0]).toMatchObject({ toolName: 'memo_read', workspaceId: '', status: 'completed' })
  })

  it('respects caller tool selection and model capability', async () => {
    const { ports, execute } = fixture()
    ports.streamTextFn = async options => {
      expect(Object.keys(options.tools as object)).not.toContain('memo_read')
      return { textStream: (async function* () { yield 'Done' })() }
    }
    await runChatTurn({ ...request, toolAllowlist: ['ask_user'] }, ports)
    ports.model.resolve = async () => ({ model: {}, modelId: 'fixture', supportsFunctionCalling: false })
    await runChatTurn(request, ports)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects collisions with built-in tools before making a model call', async () => {
    const { ports } = fixture()
    ports.localTools![0].name = 'todo_write'
    const stream = vi.fn(ports.streamTextFn)
    ports.streamTextFn = stream
    await expect(runChatTurn(request, ports)).rejects.toThrow('reserved host tool')
    expect(stream).not.toHaveBeenCalled()
  })

  it('runs application tools with a workspace through the same caller gate', async () => {
    const { ports, execute } = fixture()
    ports.sessions.getSession = () => ({ sessionId: 'session', workspaceId: 'workspace', workspaceRoot: '/fixture', status: 'running' })
    let rounds = 0
    ports.streamTextFn = async () => {
      if (rounds++ === 0) return { textStream: (async function* () {})(), fullStream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'read', toolName: 'memo_read', args: {} }
        yield { type: 'finish', finishReason: 'tool-calls' }
      })() }
      return { textStream: (async function* () { yield 'Done' })() }
    }
    const gate = vi.fn(async () => ({ block: true as const, reason: 'Caller disabled memo tools' }))
    await runChatTurn({ ...request, sourceTag: 'janus-chat', toolGate: gate, workspaceResources: [{ workspaceId: 'workspace', workspacePath: '/fixture', workspaceName: 'Fixture', agentSessionId: 'session' }] }, ports)
    expect(gate).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })
})
