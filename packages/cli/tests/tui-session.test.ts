/**
 * CliSession: validation, multi-turn history, tool-trace replay, abort.
 * Real WorkspaceAgentRuntime, stub model transport (no network).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliSession, isSessionValidationError } from '../src/session.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(text: string, capture?: { messages?: unknown[] }): StreamFn {
  return (async (opts: Record<string, unknown>) => {
    if (capture) capture.messages = (opts as { messages?: unknown[] }).messages
    return { textStream: (async function* () { yield text })() }
  }) as StreamFn
}

describe('CliSession.create', () => {
  it('rejects bad workspace with a code; missing model enters and fails turns until set', async () => {
    const badWs = await CliSession.create({
      workspace: join(tmpdir(), 'janus-cli-nope-404'), model: 'm', apiKey: 'k',
    })
    expect(isSessionValidationError(badWs) && badWs.code).toBe('bad-workspace')

    const dir = mkdtempSync(join(tmpdir(), 'janus-session-nomodel-'))
    const session = await CliSession.create({ workspace: dir, apiKey: 'k' })
    if (isSessionValidationError(session)) throw new Error(session.message)
    expect(session.getModelId()).toBeUndefined()
    await expect(session.sendTurn('hi')).rejects.toThrow(/missing model/)
    session.setModel('m')
    expect(session.getModelId()).toBe('m')
    await session.close()
  })

  it('enters without an api key; real-transport turns fail until setApiKey unlocks them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-nokey-'))
    const session = await CliSession.create({ workspace: dir, model: 'm' })
    if (isSessionValidationError(session)) throw new Error(session.message)
    expect(session.hasApiKey()).toBe(false)
    expect(session.getApiKey()).toBeUndefined()
    await expect(session.sendTurn('hi')).rejects.toThrow(/missing API key/)
    expect(() => session.setApiKey('   ')).toThrow(/usage: \/key/)
    session.setApiKey('k')
    expect(session.hasApiKey()).toBe(true)
    expect(session.getApiKey()).toBe('k')
    await session.close()
  })

  it('lets an injected transport run keyless (test/dev seam)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-nokey-stub-'))
    const session = await CliSession.create({
      workspace: dir, model: 'm', streamTextFn: textStub('unblocked'),
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    const result = await session.sendTurn('hi')
    expect(result.cancelled).toBe(false)
    expect(result.text).toContain('unblocked')
    await session.close()
  })
})

describe('CliSession.sendTurn', () => {
  it('accumulates messages across turns and replays them to the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-history-'))
    const first: { messages?: unknown[] } = {}
    const second: { messages?: unknown[] } = {}
    let calls = 0
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      streamTextFn: (async (opts: Record<string, unknown>) => {
        calls += 1
        const capture = calls === 1 ? first : second
        capture.messages = (opts as { messages?: unknown[] }).messages
        const text = calls === 1 ? 'reply-one' : 'reply-two'
        return { textStream: (async function* () { yield text })() }
      }) as StreamFn,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)

    const r1 = await session.sendTurn('first')
    expect(r1.cancelled).toBe(false)
    expect(r1.text).toContain('reply-one')
    const r2 = await session.sendTurn('second')
    expect(r2.text).toContain('reply-two')
    expect(session.getTurnCount()).toBe(2)

    const roles = (second.messages as Array<{ role: string; content: string }>).map((m) => m.role)
    const userAssistant = roles.filter((r) => r === 'user' || r === 'assistant')
    expect(userAssistant).toEqual(['user', 'assistant', 'user'])
    const contents = (second.messages as Array<{ role: string; content: string }>).map((m) => m.content)
    expect(contents.some((c) => c.includes('first'))).toBe(true)
    expect(contents.some((c) => c.includes('reply-one'))).toBe(true)
    expect(contents.some((c) => c.includes('second'))).toBe(true)
    await session.close()
  })

  it('replays executed tool traces into the next turn context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-tools-'))
    writeFileSync(join(dir, 'hello.txt'), 'tool-content-here')
    const captures: unknown[][] = []
    let calls = 0
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      streamTextFn: (async (opts: Record<string, unknown>) => {
        calls += 1
        captures.push(((opts as { messages?: unknown[] }).messages ?? []) as unknown[])
        if (calls === 1) {
          return {
            fullStream: (async function* () {
              yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'cli', path: 'hello.txt' } }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        return { textStream: (async function* () { yield 'saw it' })() }
      }) as unknown as StreamFn,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)

    await session.sendTurn('read hello.txt')
    await session.sendTurn('what did you see?')
    expect(JSON.stringify(captures[1])).toContain('hello.txt')
    await session.close()
  })

  it('keeps history on abort and stays usable afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-abort-'))
    const session = await CliSession.create({
      workspace: dir, model: 'm', apiKey: 'k', streamTextFn: textStub('late'),
    })
    if (isSessionValidationError(session)) throw new Error(session.message)

    const controller = new AbortController()
    const result = await session.sendTurn(
      'hi',
      { onEvent: () => controller.abort() },
      controller.signal,
    )
    expect(result.cancelled).toBe(true)
    expect(session.getTurnCount()).toBe(1)
    const retry = await session.sendTurn('again')
    expect(retry.cancelled).toBe(false)
    expect(session.getTurnCount()).toBe(2)
    await session.close()
  })

  it('supports model switching and history clearing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-session-misc-'))
    const seen: unknown[][] = []
    const session = await CliSession.create({
      workspace: dir,
      model: 'm1',
      apiKey: 'k',
      streamTextFn: (async (opts: Record<string, unknown>) => {
        seen.push((((opts as { model?: unknown }).model) !== undefined ? [1] : []) as unknown[])
        return { textStream: (async function* () { yield 'ok' })() }
      }) as StreamFn,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    expect(session.getModelId()).toBe('m1')
    session.setModel('m2')
    expect(session.getModelId()).toBe('m2')
    await session.sendTurn('hi')
    expect(session.getTurnCount()).toBe(1)
    await session.clearHistory()
    expect(session.getTurnCount()).toBe(0)
    await session.close()
  })
})
