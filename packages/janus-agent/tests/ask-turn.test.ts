/**
 * ask_user turn: the loop tool blocks on the host question UI, emits
 * `question_requested`/`question_resolved`, records a trace, and appends
 * the confirmed plan to the turn text. Budget, cancel, and headless-deny
 * paths stay fail-safe.
 */
import { describe, expect, it } from 'vitest'
import type { ChatAgentEvent } from '@janus-agent/chat-core'
import { runChatTurn } from '../src/orchestrator/chat-turn.js'
import type { ChatTurnPorts } from '../src/ports.js'

function stubPorts(overrides: Partial<ChatTurnPorts> = {}): ChatTurnPorts {
  return {
    model: {
      resolve: async (_providerId, modelId) => ({ model: { id: modelId ?? 'm' }, modelId: modelId ?? 'm' }),
      getMaxTurns: () => 5,
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

const QUESTION_ARGS = {
  questions: [
    {
      question: 'Which API style?',
      header: 'API style',
      options: [{ label: 'REST', description: 'simple' }, { label: 'GraphQL', description: 'flexible' }],
    },
  ],
}

function askStream(onCall = 1) {
  let n = 0
  return async () => {
    n += 1
    if (n === onCall) {
      return {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: `q${n}`, toolName: 'ask_user', args: QUESTION_ARGS }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(),
        textStream: (async function* () { })(),
      }
    }
    return { textStream: (async function* () { yield 'done' })() }
  }
}

describe('ask_user loop tool', () => {
  it('asks, records the answer trace, and appends the confirmed plan', async () => {
    const events: ChatAgentEvent[] = []
    const seen: Array<{ questions: unknown; allowCustom: unknown }> = []
    const ports = stubPorts({
      streamTextFn: askStream() as never,
      question: {
        askUser: async (request) => {
          seen.push({ questions: request.questions, allowCustom: request.allowCustom })
          return { status: 'answered', answers: [{ header: 'API style', selected: ['REST'] }] }
        },
      },
    })
    const result = await runChatTurn(
      { requestId: 'ask-1', messages: [{ role: 'user', content: 'build it' }], providerId: 'p' },
      ports,
      { onEvent: (e) => events.push(e) },
    )
    expect(events.some((e) => e.type === 'question_requested')).toBe(true)
    expect(events.some((e) => e.type === 'question_resolved' && e.status === 'answered')).toBe(true)
    expect(seen).toHaveLength(1)
    expect(result.toolTraces.some((t) => t.toolName === 'ask_user' && t.status === 'completed')).toBe(true)
    expect(result.text).toContain('API style → REST')
  })

  it('treats user cancel as a correctable isError and keeps the turn alive', async () => {
    const events: ChatAgentEvent[] = []
    const ports = stubPorts({
      streamTextFn: askStream() as never,
      question: { askUser: async () => ({ status: 'cancelled' }) },
    })
    const result = await runChatTurn(
      { requestId: 'ask-2', messages: [{ role: 'user', content: 'build it' }], providerId: 'p' },
      ports,
      { onEvent: (e) => events.push(e) },
    )
    expect(events.some((e) => e.type === 'question_resolved' && e.status === 'cancelled')).toBe(true)
    expect(result.toolTraces.some((t) => t.toolName === 'ask_user')).toBe(true)
    expect(result.text).toContain('done')
    expect(result.text).not.toContain('Confirmed via ask_user')
  })

  it('denies without a question UI (headless) instead of hanging', async () => {
    const ports = stubPorts({ streamTextFn: askStream() as never })
    const result = await runChatTurn(
      { requestId: 'ask-3', messages: [{ role: 'user', content: 'build it' }], providerId: 'p' },
      ports,
    )
    expect(result.toolTraces).toEqual([])
    expect(result.text).toContain('done')
  })

  it('blocks past the per-turn budget without opening the UI', async () => {
    let n = 0
    const asked: string[] = []
    const ports = stubPorts({
      streamTextFn: (async () => {
        n += 1
        if (n <= 3) {
          return {
            fullStream: (async function* () {
              yield { type: 'tool-call', toolCallId: `b${n}`, toolName: 'ask_user', args: QUESTION_ARGS }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        return { textStream: (async function* () { yield 'done' })() }
      }) as never,
      question: {
        askUser: async (request) => {
          asked.push(request.callId)
          return { status: 'answered', answers: [{ header: 'API style', selected: ['REST'] }] }
        },
      },
    })
    const events: ChatAgentEvent[] = []
    const result = await runChatTurn(
      { requestId: 'ask-4', messages: [{ role: 'user', content: 'build it' }], providerId: 'p' },
      ports,
      { onEvent: (e) => events.push(e) },
    )
    // Two calls open the UI; the third is blocked before any prompt.
    expect(asked).toHaveLength(2)
    expect(events.filter((e) => e.type === 'question_requested')).toHaveLength(2)
    expect(result.text).toContain('done')
  })
})
