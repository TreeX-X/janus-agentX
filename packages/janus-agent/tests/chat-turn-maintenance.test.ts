/**
 * runChatTurn maintenance hosting: system prefix, tool allowlist, and the
 * read-only `maintenance` sourceTag (workspaces resolve, personal recall and
 * capture never run). No network, no Electron, stub ports only.
 */
import { describe, expect, it, vi } from 'vitest'
import { runChatTurn } from '../src/orchestrator/chat-turn'
import type { ChatTurnPorts } from '../src/ports'

function readManifest() {
  return {
    name: 'workspace.read',
    description: 'read',
    inputSchema: { type: 'object', properties: {} },
    actionRisk: 'read',
  } as never
}

function editManifest() {
  return {
    name: 'workspace.edit',
    description: 'edit',
    inputSchema: { type: 'object', properties: {} },
    actionRisk: 'write',
  } as never
}

function runningSession() {
  return {
    getSession: (id: string) => id === 's1'
      ? { sessionId: 's1', workspaceId: 'w', workspaceRoot: '/tmp/w', status: 'running' }
      : null,
  }
}

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
      textStream: (async function* () { yield 'ok' })(),
    }),
    ...overrides,
  }
}

function captureStream(calls: unknown[][], text = 'ok') {
  return async (options: Record<string, unknown>) => {
    calls.push([options.messages, options.tools ? Object.keys(options.tools as object) : []])
    return { textStream: (async function* () { yield text })() }
  }
}

const flat = (name: string): string => name.toLowerCase().replace(/[._-]+/g, '')

describe('runChatTurn maintenance hosting', () => {
  it('prepends the caller system prefix before the built prompt', async () => {
    const calls: unknown[][] = []
    await runChatTurn(
      {
        requestId: 'm-prefix',
        messages: [{ role: 'user', content: 'hi' }],
        providerId: 'p',
        systemPromptPrefix: 'Maintenance domain rules: never emit a ChangeSet.',
      },
      stubPorts({ streamTextFn: captureStream(calls) }),
    )
    const messages = calls[0]?.[0] as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe('Maintenance domain rules: never emit a ChangeSet.')
    expect(messages[1]?.role).toBe('system')
    expect(messages[1]?.content.length).toBeGreaterThan(0)
  })

  it('intersects the offering with the allowlist, dropping edit/todo/ask', async () => {
    const calls: unknown[][] = []
    await runChatTurn(
      {
        requestId: 'm-allow',
        messages: [{ role: 'user', content: 'read a.ts' }],
        providerId: 'p',
        sourceTag: 'maintenance',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
        toolAllowlist: ['workspace.read'],
      },
      stubPorts({
        sessions: runningSession(),
        tools: {
          executeFunctionCall: async () => ({ status: 'completed' }) as never,
          registry: { list: () => [readManifest(), editManifest()] },
        },
        streamTextFn: captureStream(calls),
      }),
    )
    const offered = (calls[0]?.[1] as string[]).map(flat)
    expect(offered).toContain('workspaceread')
    expect(offered).not.toContain('workspaceedit')
    expect(offered).not.toContain('todowrite')
    expect(offered).not.toContain('askuser')
  })

  it('keeps the standard todo/ask offering without an allowlist', async () => {
    const calls: unknown[][] = []
    await runChatTurn(
      {
        requestId: 'm-full',
        messages: [{ role: 'user', content: 'hi' }],
        providerId: 'p',
      },
      stubPorts({ streamTextFn: captureStream(calls) }),
    )
    const offered = (calls[0]?.[1] as string[]).map(flat)
    expect(offered).toContain('todowrite')
    expect(offered).toContain('askuser')
  })

  it('resolves maintenance workspaces without recall or capture', async () => {
    const captureTurn = vi.fn()
    const search = vi.fn()
    const calls: unknown[][] = []
    let n = 0
    const result = await runChatTurn(
      {
        requestId: 'm-resolve',
        messages: [{ role: 'user', content: 'read a.ts' }],
        providerId: 'p',
        sourceTag: 'maintenance',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
        toolAllowlist: ['workspace.read'],
      },
      stubPorts({
        sessions: runningSession(),
        tools: {
          executeFunctionCall: async (input) => ({
            status: 'completed', toolName: input.call.toolName, output: { path: 'a.ts' },
          }) as never,
          registry: { list: () => [readManifest()] },
        },
        knowledgeSearch: search as never,
        knowledgeCapture: { captureTurn } as never,
        streamTextFn: (async (options: Record<string, unknown>) => {
          calls.push([options.messages, []])
          n += 1
          if (n === 1) {
            return {
              fullStream: (async function* () {
                yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'w', path: 'a.ts' } }
                yield { type: 'finish', finishReason: 'tool-calls' }
              })(),
              textStream: (async function* () {})(),
            }
          }
          return { textStream: (async function* () { yield 'read it' })() }
        }) as never,
      }),
    )
    expect(result.toolTraces.some((entry) => flat(entry.toolName) === 'workspaceread')).toBe(true)
    expect(captureTurn).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('skips the mutation recovery follow-up when the allowlist is read-only', async () => {
    const readOnlyCalls: unknown[][] = []
    await runChatTurn(
      {
        requestId: 'm-norecovery',
        messages: [{ role: 'user', content: 'edit a.ts to fix the bug' }],
        providerId: 'p',
        sourceTag: 'maintenance',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
        toolAllowlist: ['workspace.read'],
      },
      stubPorts({
        sessions: runningSession(),
        tools: {
          executeFunctionCall: async () => ({ status: 'completed' }) as never,
          registry: { list: () => [readManifest(), editManifest()] },
        },
        streamTextFn: captureStream(readOnlyCalls, ''),
      }),
    )
    expect(readOnlyCalls).toHaveLength(1)
  })

  it('keeps the recovery follow-up when mutation tools are offered', async () => {
    const calls: unknown[][] = []
    await runChatTurn(
      {
        requestId: 'm-recovery',
        messages: [{ role: 'user', content: 'edit a.ts to fix the bug' }],
        providerId: 'p',
        sourceTag: 'janus-chat',
        workspaceResources: [{ workspaceId: 'w', workspacePath: '/tmp/w', workspaceName: 'w', agentSessionId: 's1' }],
      },
      stubPorts({
        sessions: runningSession(),
        tools: {
          executeFunctionCall: async () => ({ status: 'completed' }) as never,
          registry: { list: () => [readManifest(), editManifest()] },
        },
        streamTextFn: captureStream(calls, ''),
      }),
    )
    expect(calls.length).toBe(2)
  })
})
