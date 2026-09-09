/**
 * Resident loop driven by injected lines (no TTY): turns, commands, config.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arrayLineSource, runRepl } from '../src/repl.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(text: string): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield text })(),
  })) as StreamFn
}

function collect() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (text: string) => { out.push(text) },
      stderr: (text: string) => { err.push(text) },
      env: {} as NodeJS.ProcessEnv,
      store: memoryConversationStore(),
      configPath: null,
      authPath: null,
    },
  }
}

describe('runRepl', () => {
  it('enters without a model; turns fail gracefully until /model sets one', async () => {
    const c = collect()
    const code = await runRepl(
      { workspace: tmpdir() },
      { ...c.io, env: { JANUS_API_KEY: 'k' } as NodeJS.ProcessEnv, lines: arrayLineSource(['hi', '/model', '/exit']) },
    )
    expect(code).toBe(0)
    expect(c.err.join('')).toContain('no model')
    expect(c.err.join('')).toContain('JANUS_MODEL')
    expect(c.err.join('')).toContain('missing model')
    expect(c.out.join('')).toContain('(no model')
  })

  it('runs turns until /exit and keeps multi-turn context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-turns-'))
    const c = collect()
    const seen: string[][] = []
    let calls = 0
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        ...c.io,
        lines: arrayLineSource(['first question', 'second question', '/exit']),
        streamTextFn: (async (opts: Record<string, unknown>) => {
          calls += 1
          seen.push(((opts as { messages?: Array<{ content: string }> }).messages ?? []).map((m) => m.content))
          return { textStream: (async function* () { yield `answer-${calls}` })() }
        }) as StreamFn,
      },
    )
    expect(code).toBe(0)
    const all = c.out.join('')
    expect(all).toContain('JANUSX')
    expect(all).toContain('answer-1')
    expect(all).toContain('answer-2')
    expect(seen[1].some((content) => content.includes('first question'))).toBe(true)
  })

  it('handles /model /clear, unknown and staged commands without exiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-commands-'))
    const c = collect()
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        ...c.io,
        lines: arrayLineSource(['/model', '/model m2', '/clear', '/nope', '/switch x', '/provider', '/help', null]),
        streamTextFn: textStub('hi'),
      },
    )
    expect(code).toBe(0)
    expect(c.out.join('')).toContain('model: m')
    expect(c.out.join('')).toContain('model switched: m2')
    expect(c.out.join('')).toContain('history cleared.')
    expect(c.out.join('')).toContain('* openai-compatible')
    expect(c.out.join('')).toContain('Commands:')
    expect(c.err.join('')).toContain('unknown command: /nope')
    expect(c.err.join('')).toContain('no conversation matches: x')
  })

  it('enters without an api key; turns fail gracefully until /key sets one', async () => {
    const c = collect()
    const code = await runRepl(
      { workspace: tmpdir() },
      { ...c.io, env: { JANUS_MODEL: 'm' } as NodeJS.ProcessEnv, lines: arrayLineSource(['hi', '/exit']) },
    )
    expect(code).toBe(0)
    expect(c.err.join('')).toContain('no API key')
    expect(c.err.join('')).toContain('JANUS_API_KEY')
  })

  it('recovers via /key and keeps chatting on the stub transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-key-'))
    const c = collect()
    const code = await runRepl(
      { workspace: dir, model: 'm', plain: true },
      {
        ...c.io,
        lines: arrayLineSource(['/key', '/key sk-test', 'hi', '/exit']),
        streamTextFn: textStub('recovered'),
      },
    )
    expect(code).toBe(0)
    expect(c.out.join('')).toContain('api key: missing')
    expect(c.out.join('')).toContain('api key set for this run')
    expect(c.out.join('')).toContain('recovered')
  })

  it('keeps the session when /workspace fails and stays usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-keep-'))
    const c = collect()
    const code = await runRepl(
      { workspace: dir, model: 'm' },
      {
        stdout: c.io.stdout,
        stderr: c.io.stderr,
        env: { JANUS_API_KEY: 'k' } as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        authPath: null,
        lines: arrayLineSource(['/model m2', '/workspace /definitely/not/here-404', 'hi', '/exit']),
        streamTextFn: textStub('still-here'),
      },
    )
    expect(code).toBe(0)
    expect(c.out.join('')).toContain('model switched: m2')
    expect(c.err.join('')).toMatch(/not a directory/)
    expect(c.out.join('')).toContain('still-here')
  })

  it('streams thinking before each answer without moving it to the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-thinking-'))
    const c = collect()
    let calls = 0
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        ...c.io,
        authPath: null,
        lines: arrayLineSource(['first', 'second', '/exit']),
        streamTextFn: (async () => {
          calls += 1
          const n = calls
          return {
            fullStream: (async function* () {
              yield { type: 'reasoning-delta', textDelta: `hmm-${n}\n` }
              yield { type: 'text-delta', textDelta: `answer-${n}` }
              yield { type: 'finish', finishReason: 'stop' }
            })(),
            textStream: (async function* () { })(),
          }
        }) as StreamFn,
      },
    )
    expect(code).toBe(0)
    const all = c.out.join('')
    expect(all).toContain('▸ thinking · hmm-1')
    expect(all).toContain('▸ thinking · hmm-2')
    expect(all.indexOf('hmm-1')).toBeLessThan(all.indexOf('answer-1'))
    expect(all.indexOf('hmm-2')).toBeLessThan(all.indexOf('answer-2'))
    expect(all).toContain('answer-2')
  })
})
