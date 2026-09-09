import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai-stream/test'
import { jsonSchema } from 'ai-stream'
import { streamChatModel } from '../src/model-stream.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { CliDisplayEvent } from '../src/tool-display.js'

const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 4, reasoning: 4 },
} } as const

describe('CLI model stream', () => {
  it('runs a real workspace tool between SDK streams and keeps reasoning separate from saved answers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'janus-sdk-stream-'))
    writeFileSync(join(workspace, 'a.txt'), 'file-body')
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls += 1
      const chunks = calls === 1 ? [
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: 'inspect a.txt' },
        { type: 'reasoning-end', id: 'r' },
        { type: 'tool-call', toolCallId: 'c', toolName: 'workspace_read', input: '{"workspaceId":"cli","path":"a.txt"}' },
        { ...finish, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
      ] : [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'File inspected.' },
        { type: 'text-end', id: 't' }, finish,
      ]
      return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }) }
    } })
    const session = await CliSession.create({ workspace, model: 'm', apiKey: 'k', store: memoryConversationStore(), env: {},
      streamTextFn: (options) => streamChatModel({ ...options, model }),
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    const events: unknown[] = []
    const display: CliDisplayEvent[] = []
    try {
      const result = await session.sendTurn('read a.txt', {
        onEvent: ({ event }) => events.push(event), onDisplayEvent: (event) => display.push(event),
      })
      expect(calls).toBe(2)
      expect(result.text).toBe('File inspected.')
      expect(events).toContainEqual(expect.objectContaining({ type: 'reasoning_delta', delta: 'inspect a.txt' }))
      expect(display).toContainEqual(expect.objectContaining({ type: 'tool-display', display: expect.objectContaining({ output: ['file-body'] }) }))
      expect(JSON.stringify(events)).not.toContain('file-body')
      expect(JSON.stringify(session.getActiveMessages())).not.toContain('inspect a.txt')
      expect(model.doStreamCalls[1].prompt.some((message) => message.role === 'tool')).toBe(true)
    } finally { await session.close() }
  })

  it('preserves reasoning, text, tool arguments and usage through the real SDK', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => ({
      stream: new ReadableStream({ start(controller) {
        for (const chunk of [
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: 'check the file' },
          { type: 'reasoning-end', id: 'r' },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Reading now.' },
          { type: 'text-end', id: 't' },
          { type: 'tool-input-start', id: 'c', toolName: 'read' },
          { type: 'tool-input-delta', id: 'c', delta: '{"path":"a.ts"}' },
          { type: 'tool-input-end', id: 'c' },
          { type: 'tool-call', toolCallId: 'c', toolName: 'read', input: '{"path":"a.ts"}', providerMetadata: { openai: { itemId: 'fc_1' } } },
          { ...finish, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
        ]) controller.enqueue(chunk)
        controller.close()
      } }),
    }) })
    const tools = { read: { parameters: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) } }
    const result = await streamChatModel({ model, messages: [{ role: 'user', content: 'hello' }], tools })
    const parts = []
    for await (const part of result.fullStream!) parts.push(part)
    expect(parts.filter((part) => part.type.endsWith('delta')).map((part) => part.type)).toEqual([
      'reasoning-delta', 'text-delta', 'tool-call-delta',
    ])
    expect(parts.find((part) => part.type === 'reasoning-delta')?.textDelta).toBe('check the file')
    expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({ args: { path: 'a.ts' } })
    expect(parts.at(-1)).toMatchObject({ type: 'finish', usage: { promptTokens: 12, completionTokens: 8 } })
    model.doStream = async (options) => {
      expect(options.prompt[0]).toMatchObject({ role: 'assistant', content: [{
        type: 'tool-call', input: { path: 'a.ts' }, providerOptions: { openai: { itemId: 'fc_1' } },
      }] })
      expect(options.prompt[1]).toMatchObject({ role: 'tool', content: [{
        type: 'tool-result', output: { type: 'json', value: { content: 'file contents' } },
      }] })
      return { stream: new ReadableStream({ start(controller) { controller.enqueue(finish); controller.close() } }) }
    }
    const followUp = await streamChatModel({ model, tools, messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', args: { path: 'a.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read', result: { content: 'file contents' } }] },
    ] })
    for await (const _ of followUp.fullStream!) { /* Consume the SDK request. */ }
    expect(model.doStreamCalls[0].tools?.[0]).toMatchObject({ name: 'read', inputSchema: { type: 'object' } })
  })

  it('forwards provider failures instead of turning them into an empty reply', async () => {
    const model = new MockLanguageModelV3({ doStream: async () => ({
      stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'error', error: new Error('offline') }); controller.close() } }),
    }) })
    const result = await streamChatModel({ model, messages: [{ role: 'user', content: 'hello' }] })
    const parts = []
    for await (const part of result.fullStream!) parts.push(part)
    expect(parts.find((part) => part.type === 'error')?.error).toMatchObject({ message: 'offline' })
  })
})
