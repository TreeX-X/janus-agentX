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

  it('recovers from a provider overflow with one forced compact plus a single retry', async () => {
    let streams = 0
    const ports = stubPorts({
      model: {
        resolve: async () => ({ model: { id: 'm' }, modelId: 'm', contextWindow: 2000, maxOutputTokens: 100 }),
        getMaxTurns: () => 3,
      },
      streamTextFn: (async () => {
        streams += 1
        if (streams === 1) throw new Error('context window exceeded (provider overflow)')
        return { textStream: (async function* () { yield 'recovered' })() }
      }) as ChatTurnPorts['streamTextFn'],
    })
    const summarize = async () => [
      '## Goal', 'Recover',
      '## Constraints & Preferences', '(none)',
      '## Progress', '### Done', '- [x] hit overflow', '### In Progress', '- [ ] retry', '### Blocked', '(none)',
      '## Key Decisions', '(none)',
      '## Next Steps', '1. retry',
      '## Critical Context', '(none)',
      '## Relevant Files', '(none)',
    ].join('\n')
    const result = await runChatTurn(
      {
        requestId: 'r7',
        messages: [
          { role: 'user' as const, content: `old exploration ${'x'.repeat(3000)}` },
          { role: 'user' as const, content: 'keep going' },
        ],
        providerId: 'p',
        chatSession: new ChatSessionRuntime(),
        compactionSummarizer: summarize,
      },
      ports,
    )
    expect(result.text).toBe('recovered')
    expect(result.compacted).toBe(true)
    expect(streams).toBe(2)
  })

  it('surfaces a second consecutive overflow instead of looping forever', async () => {    let streams = 0
    const ports = stubPorts({
      streamTextFn: (async () => {
        streams += 1
        throw new Error('413 Request Entity Too Large')
      }) as ChatTurnPorts['streamTextFn'],
    })
    const summarize = async () => [
      '## Goal', 'Overflow',
      '## Constraints & Preferences', '(none)',
      '## Progress', '### Done', '(none)', '### In Progress', '- [ ] x', '### Blocked', '(none)',
      '## Key Decisions', '(none)',
      '## Next Steps', '1. x',
      '## Critical Context', '(none)',
      '## Relevant Files', '(none)',
    ].join('\n')
    await expect(runChatTurn(
      {
        requestId: 'r8',
        messages: [{ role: 'user' as const, content: 'hi' }],
        providerId: 'p',
        chatSession: new ChatSessionRuntime(),
        compactionSummarizer: summarize,
      },
      ports,
    )).rejects.toThrow('413')
    expect(streams).toBe(2)
  })

  it('maps a transport abort rejection to a cancelled result instead of throwing', async () => {
    const controller = new AbortController()
    const ports = stubPorts({
      streamTextFn: (async () => {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }) as ChatTurnPorts['streamTextFn'],
    })
    const events: string[] = []
    const result = await runChatTurn(
      { requestId: 'r9', messages: [{ role: 'user' as const, content: 'hi' }], providerId: 'p' },
      ports,
      { onEvent: (e) => events.push(e.type) },
      controller.signal,
    )
    expect(result.cancelled).toBe(true)
    expect(events).toContain('stream_end')
  })

  it('reports max-turns exhaustion with a resume hint instead of silent truncation', async () => {
    const ports = stubPorts({
      model: {
        resolve: async () => ({ model: { id: 'm' }, modelId: 'm' }),
        getMaxTurns: () => 1,
      },
      streamTextFn: (async () => ({
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'c1', toolName: 'missing-tool', args: {} }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(),
        textStream: (async function* () { })(),
      })) as ChatTurnPorts['streamTextFn'],
    })
    const result = await runChatTurn(
      { requestId: 'r10', messages: [{ role: 'user' as const, content: 'hi' }], providerId: 'p' },
      ports,
    )
    expect(result.cancelled).toBe(false)
    expect(result.text).toContain('Stopped after 1 turns')
    expect(result.text).toContain("'continue'")
  })

  function failurePorts(outcome: { status: string; error?: string }, streams: { count: number }) {
    return stubPorts({
      sessions: {
        getSession: (id) => id === 's1'
          ? { sessionId: 's1', workspaceId: 'w', workspaceRoot: '/tmp/w', status: 'running' }
          : null,
      },
      tools: {
        executeFunctionCall: async (input) => ({
          status: outcome.status, toolName: input.call.toolName,
          ...(outcome.error ? { error: outcome.error } : {}),
          output: { path: 'a.ts' },
        }) as never,
        registry: {
          list: () => [{
            name: 'workspace.read', description: 'read',
            inputSchema: { type: 'object', properties: {} },
            actionRisk: 'read',
          }] as never,
        },
      },
      streamTextFn: (async () => {
        streams.count += 1
        if (streams.count === 1) {
          return {
            fullStream: (async function* () {
              yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'w', path: 'a.ts' } }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        if (streams.count === 2) {
          return { textStream: (async function* () { yield 'stuck' })() }
        }
        return { textStream: (async function* () { yield 'fixed' })() }
      }) as ChatTurnPorts['streamTextFn'],
    })
  }

  function failureRequest(requestId: string) {
    return {
      requestId, messages: [{ role: 'user' as const, content: 'check a.ts' }], providerId: 'p',
      sourceTag: 'janus-chat' as const,
      workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
    }
  }

  it('nudges one repair round after a fixable tool failure instead of blind retry', async () => {
    const streams = { count: 0 }
    const result = await runChatTurn(
      failureRequest('r11'),
      failurePorts({ status: 'failed', error: 'workspace.read failed: file not found, check the path' }, streams),
    )
    expect(streams.count).toBe(3)
    expect(result.text).toContain('fixed')
    expect(result.toolTraces.some((trace) => trace.status === 'failed')).toBe(true)
  })

  it('skips the repair nudge for denied approvals', async () => {
    const streams = { count: 0 }
    const result = await runChatTurn(
      failureRequest('r12'),
      failurePorts({ status: 'denied', error: 'User denied the approval' }, streams),
    )
    expect(streams.count).toBe(2)
    expect(result.text).toContain('stuck')
  })
  it('does not reopen a failure after a corrected tool batch succeeds', async () => {
    const count = { count: 0 }
    const ports = failurePorts({ status: 'failed', error: 'file not found' }, count)
    let executions = 0
    ports.model.getMaxTurns = () => 8
    ports.tools.executeFunctionCall = async (input) => ({
      status: ++executions === 1 ? 'failed' : 'completed', toolName: input.call.toolName,
      ...(executions === 1 ? { error: 'file not found' } : {}), output: { path: 'a.ts' },
    }) as never
    ports.streamTextFn = async () => {
      count.count++
      if (count.count <= 2) return {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'c' + count.count, toolName: 'workspace_read', args: { workspaceId: 'w', path: count.count === 1 ? 'wrong.ts' : 'a.ts' } }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(), textStream: (async function* () {})(),
      }
      return { textStream: (async function* () { yield 'done' })() }
    }
    await runChatTurn(failureRequest('repaired'), ports)
    expect(executions).toBe(2)
    expect(count.count).toBe(3)
  })

  it('keeps completed tools in context when a later model request overflows', async () => {
    const count = { count: 0 }
    const ports = failurePorts({ status: 'completed' }, count)
    let executions = 0
    ports.tools.executeFunctionCall = async (input) => {
      executions++
      return { status: 'completed', toolName: input.call.toolName, output: { path: 'a.ts', content: 'verified marker' } } as never
    }
    ports.streamTextFn = async (options) => {
      count.count++
      if (count.count === 2) throw new Error('context window exceeded')
      const hasTool = (options.messages as Array<{ role: string }>).some((message) => message.role === 'tool')
      if (!hasTool) return {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'read-once', toolName: 'workspace_read', args: { workspaceId: 'w', path: 'a.ts' } }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(), textStream: (async function* () {})(),
      }
      return { textStream: (async function* () { yield 'done' })() }
    }
    await runChatTurn({ ...failureRequest('overflow-after-tool'), compactionSummarizer: async () => '## Goal\nInspect\n## Progress\nRead\n## Next Steps\nAnswer' }, ports)
    expect(count.count).toBe(3)
    expect(executions).toBe(1)
  })

  it('blocks repeated identical failing calls instead of spending the turn cap', async () => {
    const count = { count: 0 }
    const ports = failurePorts({ status: 'failed', error: 'missing file' }, count)
    let executions = 0
    const execute = ports.tools.executeFunctionCall
    ports.tools.executeFunctionCall = async (...args) => { executions++; return execute(...args) }
    ports.model.getMaxTurns = () => 20
    ports.streamTextFn = async () => {
      count.count++
      return {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'c' + count.count, toolName: 'workspace_read', args: { workspaceId: 'w', path: 'missing.ts' } }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(), textStream: (async function* () {})(),
      }
    }
    await runChatTurn(failureRequest('repeat-failure'), ports)
    expect(executions).toBe(1)
    expect(count.count).toBe(3)
  })

  it('allows the same read after a successful mutation repairs its precondition', async () => {
    const count = { count: 0 }
    const ports = failurePorts({ status: 'completed' }, count)
    ports.model.getMaxTurns = () => 8
    ports.tools.registry.list = () => ['workspace.read', 'workspace.create'].map((name) => ({ name, description: name, inputSchema: { type: 'object' }, actionRisk: name.endsWith('read') ? 'read' : 'write' })) as never
    const calls: string[] = []
    ports.tools.executeFunctionCall = async (input) => {
      calls.push(input.call.toolName)
      return { toolName: input.call.toolName, status: calls.length === 1 ? 'failed' : 'completed', ...(calls.length === 1 ? { error: 'missing file' } : {}), output: { path: 'a.ts' } } as never
    }
    ports.streamTextFn = async () => {
      count.count++
      if (count.count > 3) return { textStream: (async function* () { yield 'done' })() }
      const creating = count.count === 2
      return { fullStream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'c' + count.count, toolName: creating ? 'workspace_create' : 'workspace_read', args: { workspaceId: 'w', path: 'a.ts', ...(creating ? { content: 'fixed' } : {}) } }
        yield { type: 'finish', finishReason: 'tool-calls' }
      })(), textStream: (async function* () {})() }
    }
    await runChatTurn(failureRequest('repaired-precondition'), ports)
    expect(calls).toEqual(['workspace.read', 'workspace.create', 'workspace.read'])
    expect(count.count).toBe(4)
  })

})
