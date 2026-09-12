/**
 * janus-agent smoke: runChatTurn orchestrates end-to-end on stub ports.
 * No network, no Electron, no filesystem beyond the test itself.
 */
import { describe, expect, it } from 'vitest'
import { runChatTurn } from '../src/orchestrator/chat-turn'
import { ChatSessionRuntime } from '@janus-agent/chat-core'
import type { ChatTurnPorts } from '../src/ports'

function stubPorts(overrides: Partial<ChatTurnPorts> = {}): ChatTurnPorts {
  return {
    model: {
      resolve: async (_providerId, modelId) => ({ model: { id: modelId ?? 'm' }, modelId: modelId ?? 'm' }),
      getMaxTurns: () => 3,
    },
    sessions: { getSession: () => null },
    tools: {
      executeFunctionCall: async () => ({ status: 'completed' }) as never,
      registry: { list: () => [] },
    },
    streamTextFn: async () => ({
      textStream: (async function* () { yield 'hello'; yield ' world' })(),
    }),
    ...overrides,
  }
}

describe('runChatTurn', () => {
  it('streams text deltas and returns the full reply', async () => {
    const deltas: string[] = []
    const result = await runChatTurn(
      { requestId: 'r1', messages: [{ role: 'user', content: 'hi' }], providerId: 'p' },
      stubPorts(),
      {
        onEvent: (e) => {
          if (e.type === 'text_delta') deltas.push(e.delta)
        },
      },
    )
    expect(result.text).toBe('hello world')
    expect(result.cancelled).toBe(false)
    expect(deltas.join('')).toBe('hello world')
  })

  it('falls back to a user-facing message when the model goes silent', async () => {
    const result = await runChatTurn(
      { requestId: 'r2', messages: [{ role: 'user', content: 'hi' }], providerId: 'p' },
      stubPorts({
        streamTextFn: async () => ({ textStream: (async function* () { })() }),
      }),
    )
    expect(result.text).toContain('请重试')
  })

  it('rejects models without function calling when workspaces are attached', async () => {
    const ports = stubPorts({
      model: {
        resolve: async () => ({ model: {}, modelId: 'm', supportsFunctionCalling: false }),
        getMaxTurns: () => 3,
      },
      sessions: {
        getSession: (id) => id === 's1'
          ? { sessionId: 's1', workspaceId: 'w', workspaceRoot: '/tmp/w', status: 'running' }
          : null,
      },
    })
    await expect(runChatTurn(
      {
        requestId: 'r3', messages: [{ role: 'user', content: 'hi' }], providerId: 'p',
        sourceTag: 'janus-chat',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
      },
      ports,
    )).rejects.toThrow('Function Calling')
  })

  it('runs workspace tools through the injected executor and captures', async () => {
    const calls: string[] = []
    const captured: unknown[] = []
    const ports = stubPorts({
      sessions: {
        getSession: (id) => id === 's1'
          ? { sessionId: 's1', workspaceId: 'w', workspaceRoot: '/tmp/w', status: 'running' }
          : null,
      },
      tools: {
        executeFunctionCall: async (input) => {
          calls.push(input.call.toolName)
          return { status: 'completed', toolName: input.call.toolName, output: { path: 'a.ts' } } as never
        },
        registry: {
          list: () => [{
            name: 'workspace.read', description: 'read',
            inputSchema: { type: 'object', properties: {} },
            actionRisk: 'read',
          }] as never,
        },
      },
      streamTextFn: (() => {
        let n = 0
        return async () => {
          n += 1
          if (n === 1) {
            return {
              fullStream: (async function* () {
                yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'w', path: 'a.ts' } }
                yield { type: 'finish', finishReason: 'tool-calls' }
              })(),
              textStream: (async function* () { })(),
            }
          }
          return { textStream: (async function* () { yield 'done' })() }
        }
      })(),
      knowledgeCapture: {
        captureTurn: async (c) => { captured.push(c) },
        notifySettled: async () => undefined,
      },
    })
    const result = await runChatTurn(
      {
        requestId: 'r4', messages: [{ role: 'user', content: 'read a.ts' }], providerId: 'p',
        sourceTag: 'janus-chat',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
      },
      ports,
    )
    expect(calls).toContain('workspace.read')
    expect(result.toolTraces.length).toBeGreaterThan(0)
    expect(result.text).toContain('done')
    expect(captured.length).toBe(1)
  })

  it('compacts evicted history through the injected summarizer exactly once', async () => {
    const seen: unknown[] = []
    let calls = 0
    const ports = stubPorts({
      model: {
        resolve: async () => ({ model: { id: 'm' }, modelId: 'm', contextWindow: 2000, maxOutputTokens: 100 }),
        getMaxTurns: () => 3,
      },
      streamTextFn: (async (opts: Record<string, unknown>) => {
        seen.push(opts.messages)
        return { textStream: (async function* () { yield 'done' })() }
      }) as ChatTurnPorts['streamTextFn'],
    })
    const chatSession = new ChatSessionRuntime()
    const summarize = async () => {
      calls += 1
      return [
        '## Goal', 'Keep going',
        '## Constraints & Preferences', '(none)',
        '## Progress', '### Done', '- [x] explored', '### In Progress', '- [ ] polish', '### Blocked', '(none)',
        '## Key Decisions', '(none)',
        '## Next Steps', '1. polish',
        '## Critical Context', '(none)',
        '## Relevant Files', '(none)',
      ].join('\n')
    }
    const request = {
      requestId: 'r5',
      messages: [{ role: 'user' as const, content: `old exploration ${'x'.repeat(5000)}` }, { role: 'user' as const, content: 'hi' }],
      providerId: 'p',
      chatSession,
      compactionSummarizer: summarize,
    }
    const first = await runChatTurn(request, ports)
    expect(first.text).toBe('done')
    expect(first.compacted).toBe(true)
    expect(calls).toBe(1)
    expect(JSON.stringify(seen[0])).toContain('[Compacted context')
    // Same history reuses the stored summary instead of summarizing again.
    const second = await runChatTurn({ ...request, requestId: 'r6' }, ports)
    expect(second.text).toBe('done')
    expect(second.compacted).toBe(false)
    expect(calls).toBe(1)
  })
})
