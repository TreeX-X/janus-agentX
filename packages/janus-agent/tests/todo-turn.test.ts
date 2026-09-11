/**
 * todo_write turn: the loop tool validates, writes back to the session, and
 * emits `todo_update` for the sticky bar above the composer.
 */
import { describe, expect, it } from 'vitest'
import { ChatSessionRuntime } from '@janus-agent/chat-core'
import { runChatTurn } from '../src/orchestrator/chat-turn.js'
import type { ChatTurnPorts } from '../src/ports.js'
import type { ChatAgentEvent } from '@janus-agent/chat-core'

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

describe('todo_write loop tool', () => {
  it('writes the list, emits todo_update, and returns the snapshot', async () => {
    const events: ChatAgentEvent[] = []
    const chatSession = new ChatSessionRuntime()
    const ports = stubPorts({
      streamTextFn: (() => {
        let n = 0
        return async () => {
          n += 1
          if (n === 1) {
            return {
              fullStream: (async function* () {
                yield {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'todo_write',
                  args: { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] },
                }
                yield { type: 'finish', finishReason: 'tool-calls' }
              })(),
              textStream: (async function* () { })(),
            }
          }
          return { textStream: (async function* () { yield 'done' })() }
        }
      })(),
    })
    const result = await runChatTurn(
      { requestId: 'todo-1', messages: [{ role: 'user', content: 'plan it' }], providerId: 'p', chatSession },
      ports,
      { onEvent: (e) => events.push(e) },
    )
    const update = events.find((e) => e.type === 'todo_update')
    expect(update?.type).toBe('todo_update')
    if (update?.type !== 'todo_update') throw new Error('missing todo_update')
    expect(update.todos).toHaveLength(2)
    expect(update.todos[0]).toMatchObject({ content: 'A', status: 'in_progress' })
    expect(result.todos).toHaveLength(2)
    expect(chatSession.getTodos()).toHaveLength(2)
    expect(result.text).toContain('done')
  })

  it('rejects dual in_progress with a correctable isError instead of crashing', async () => {
    const events: ChatAgentEvent[] = []
    const ports = stubPorts({
      streamTextFn: (() => {
        let n = 0
        return async () => {
          n += 1
          if (n === 1) {
            return {
              fullStream: (async function* () {
                yield {
                  type: 'tool-call',
                  toolCallId: 't2',
                  toolName: 'todo_write',
                  args: { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }] },
                }
                yield { type: 'finish', finishReason: 'tool-calls' }
              })(),
              textStream: (async function* () { })(),
            }
          }
          return { textStream: (async function* () { yield 'recovered' })() }
        }
      })(),
    })
    const result = await runChatTurn(
      { requestId: 'todo-2', messages: [{ role: 'user', content: 'plan it' }], providerId: 'p' },
      ports,
      { onEvent: (e) => events.push(e) },
    )
    expect(events.some((e) => e.type === 'todo_update')).toBe(false)
    expect(result.todos).toHaveLength(0)
    expect(result.text).toContain('recovered')
  })

  it('replays the pre-turn list as a single system message', async () => {
    const seen: unknown[] = []
    const chatSession = new ChatSessionRuntime()
    chatSession.setTodos([{ content: 'Keep going', status: 'in_progress' }])
    const ports = stubPorts({
      streamTextFn: async (options) => {
        seen.push(options)
        return { textStream: (async function* () { yield 'ok' })() }
      },
    })
    await runChatTurn(
      { requestId: 'todo-3', messages: [{ role: 'user', content: 'hi' }], providerId: 'p', chatSession },
      ports,
    )
    const messages = (seen[0] as { messages: Array<{ role: string; content: string }> }).messages
    const todoMessages = messages.filter((m) => m.role === 'system' && m.content.includes('[in_progress] Keep going'))
    expect(todoMessages).toHaveLength(1)
  })
})
