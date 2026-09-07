/**
 * Multi-conversation registry: lifecycle, refs, file persistence,
 * session isolation, and REPL wiring. Stub transport, no network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConversationRegistry,
  DEFAULT_CONVERSATION_TITLE,
  fileConversationStore,
  memoryConversationStore,
  titleFromPrompt,
} from '../src/conversations.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { arrayLineSource, runRepl } from '../src/repl.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(answer: (calls: number) => string, onMessages?: (messages: unknown[]) => void): StreamFn {
  let calls = 0
  return (async (opts: Record<string, unknown>) => {
    calls += 1
    onMessages?.((((opts as { messages?: unknown[] }).messages ?? []) as unknown[]))
    return { textStream: (async function* () { yield answer(calls) })() }
  }) as StreamFn
}

describe('titleFromPrompt', () => {
  it('collapses whitespace and caps length', () => {
    expect(titleFromPrompt('  hello\n  world  ')).toBe('hello world')
    expect(titleFromPrompt('   ')).toBe(DEFAULT_CONVERSATION_TITLE)
    expect(titleFromPrompt('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
})

describe('ConversationRegistry', () => {
  it('starts with one default conversation and creates/switches by ref', async () => {
    const registry = await ConversationRegistry.load(memoryConversationStore())
    expect(registry.list()).toHaveLength(1)
    const firstId = registry.getActiveId()

    const secondId = await registry.create('Work topic')
    expect(registry.getActiveId()).toBe(secondId)
    // Newest first.
    expect(registry.list()[0].id).toBe(secondId)
    expect(registry.list()[1].id).toBe(firstId)

    expect((await registry.switch('1'))?.id).toBe(secondId)
    expect((await registry.switch('2'))?.id).toBe(firstId)
    expect((await registry.switch(firstId))?.id).toBe(firstId)
    expect((await registry.switch(firstId.slice(0, 8)))?.id).toBe(firstId)
    expect(await registry.switch('nope')).toBeNull()
    expect(await registry.switch('99')).toBeNull()
  })

  it('rejects ambiguous prefixes and renames the resolved conversation', async () => {
    const store = memoryConversationStore([
      { id: 'ab-1', title: 'one', createdAt: 1, updatedAt: 1, messages: [], toolTraces: [] },
      { id: 'ab-2', title: 'two', createdAt: 2, updatedAt: 2, messages: [], toolTraces: [] },
    ])
    const registry = await ConversationRegistry.load(store)
    expect(registry.resolveRef('ab')).toBeNull()
    expect(registry.resolveRef('ab-1')).toBe('ab-1')
    const renamed = await registry.rename('ab-2', '  Second Topic  ')
    expect(renamed?.title).toBe('Second Topic')
    expect(await registry.rename('ab-2', '   ')).toBeNull()
  })

  it('delete falls back and never empties the registry', async () => {
    const registry = await ConversationRegistry.load(memoryConversationStore())
    const only = registry.getActiveId()
    const fresh = await registry.delete(only)
    expect(fresh).not.toBe(only)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].title).toBe(DEFAULT_CONVERSATION_TITLE)

    const a = await registry.create('A')
    await registry.create('B')
    const fallback = await registry.delete(a)
    expect(fallback).not.toBe(a)
    expect(registry.list().some((summary) => summary.id === a)).toBe(false)
    expect(await registry.delete('missing')).toBeNull()
  })

  it('persists across registry instances via the file store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-conv-store-'))
    const store = fileConversationStore(dir)
    const first = await ConversationRegistry.load(store)
    const id = await first.create('Persisted work')
    first.getActive().data.messages.push({ role: 'user', content: 'remember me' })
    await first.persist(id)

    const second = await ConversationRegistry.load(fileConversationStore(dir))
    expect(second.list().some((summary) => summary.id === id && summary.title === 'Persisted work')).toBe(true)
    expect(second.list().find((summary) => summary.id === id)?.turnCount).toBe(1)
    expect((await second.switch(id))?.title).toBe('Persisted work')

    await second.delete(id)
    const third = await ConversationRegistry.load(fileConversationStore(dir))
    expect(third.list().some((summary) => summary.id === id)).toBe(false)
  })

  it('skips corrupt history files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-conv-corrupt-'))
    writeFileSync(join(dir, 'broken.jsonl'), 'not json\n', 'utf8')
    writeFileSync(join(dir, 'empty.jsonl'), '{"id":"","messages":[]}\n', 'utf8')
    const errors: unknown[] = []
    const registry = await ConversationRegistry.load(fileConversationStore(dir, (error) => { errors.push(error) }))
    // Both files skipped; registry seeds one fresh conversation.
    expect(registry.list()).toHaveLength(1)
  })
})

describe('CliSession conversations', () => {
  it('isolates histories per conversation and derives titles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-conv-isolation-'))
    const captured: unknown[][] = []
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      store: memoryConversationStore(),
      streamTextFn: textStub((calls) => `answer-${calls}`, (messages) => { captured.push(messages) }),
    })
    if (isSessionValidationError(session)) throw new Error(session.message)

    await session.sendTurn('alpha-marker question')
    expect(session.listConversations()[0].title).toContain('alpha-marker')
    await session.createConversation('second thread')
    await session.sendTurn('beta-marker question')

    expect(JSON.stringify(captured[1])).not.toContain('alpha-marker')
    expect(JSON.stringify(captured[1])).toContain('beta-marker')

    const back = await session.switchConversation('2')
    expect(back?.title).toContain('alpha-marker')
    await session.sendTurn('follow-up')
    expect(JSON.stringify(captured[2])).toContain('alpha-marker')
    expect(session.getTurnCount()).toBe(2)
    await session.close()
  })

  it('restores persisted conversations in a new session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-conv-restore-'))
    const historyDir = mkdtempSync(join(tmpdir(), 'janus-conv-history-'))
    const first = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      store: fileConversationStore(historyDir),
      streamTextFn: textStub(() => 'one'),
    })
    if (isSessionValidationError(first)) throw new Error(first.message)
    await first.sendTurn('persisted-marker prompt')
    await first.renameConversation(first.getConversationId(), 'Saved thread')
    await first.close()

    const captured: unknown[][] = []
    const second = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      store: fileConversationStore(historyDir),
      streamTextFn: textStub(() => 'two', (messages) => { captured.push(messages) }),
    })
    if (isSessionValidationError(second)) throw new Error(second.message)
    expect(second.listConversations().some((summary) => summary.title === 'Saved thread')).toBe(true)
    await second.sendTurn('continue')
    expect(JSON.stringify(captured[0])).toContain('persisted-marker prompt')
    await second.close()
  })
})

describe('runRepl conversations', () => {
  it('runs /new /list /switch /rename /delete without dropping turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-conv-'))
    const out: string[] = []
    const err: string[] = []
    let calls = 0
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: (text) => { err.push(text) },
        env: {} as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        lines: arrayLineSource([
          '/new research',
          'deep question here',
          '/list',
          '/switch 2',
          '/rename main',
          '/delete 1',
          '/exit',
        ]),
        streamTextFn: textStub(() => { calls += 1; return `answer-${calls}` }),
      },
    )
    expect(code).toBe(0)
    const all = out.join('')
    expect(all).toContain('new conversation:')
    expect(all).toContain('research')
    expect(all).toContain('answer-1')
    expect(all).toContain('switched to:')
    expect(all).toContain('renamed to: main')
    expect(all).toContain('deleted. active:')
    expect(err.join('')).toBe('')
  })
})
