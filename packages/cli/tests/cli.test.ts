/**
 * CLI smoke: argv parsing is pure and fully pinned; chat wiring runs
 * end-to-end on a stub model transport (no network) with a real
 * WorkspaceAgentRuntime over a temp workspace.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from '../src/args.js'
import { runChat } from '../src/cli.js'

describe('parseArgs', () => {
  it('parses a full chat command', () => {
    const parsed = parseArgs(
      ['chat', '--workspace', '/tmp/w', '--model', 'm', '--base-url', 'http://x/v1', '--api-key', 'k',
        '--max-turns', '5', '--timeout-ms', '5000', '--conversation', 'c1', 'do', 'things'],
      '/base',
    )
    expect(parsed.command).toBe('chat')
    expect(parsed.chat).toMatchObject({
      workspace: '/tmp/w', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k',
      maxTurns: 5, timeoutMs: 5000, conversationId: 'c1', prompt: 'do things',
    })
  })

  it('supports -C/-m shorthands and the -- separator', () => {
    const parsed = parseArgs(['chat', '-C', '/w', '-m', 'm', '--', '--not-a-flag'], '/base')
    expect(parsed.chat).toMatchObject({ workspace: '/w', model: 'm', prompt: '--not-a-flag' })
  })

  it('defaults workspace to cwd and leaves model to env', () => {
    const parsed = parseArgs(['chat', 'hi'], '/base')
    expect(parsed.chat).toMatchObject({ workspace: '/base', prompt: 'hi' })
    expect(parsed.chat?.model).toBeUndefined()
  })

  it('rejects bad input with actionable errors', () => {
    expect(parseArgs(['chat'], '/b').error).toMatch(/Missing prompt/)
    expect(parseArgs(['chat', '--max-turns', 'x', 'y'], '/b').error).toMatch(/Invalid --max-turns/)
    expect(parseArgs(['chat', '--timeout-ms', 'x', 'y'], '/b').error).toMatch(/Invalid --timeout-ms/)
    expect(parseArgs(['chat', '--approval-mode', 'per-action', 'y'], '/b').error).toMatch(/Only auto-run/)
    expect(parseArgs(['chat', '--nope', 'y'], '/b').error).toMatch(/Unknown flag/)
    expect(parseArgs(['run', 'x'], '/b').command).toBe('help')
    expect(parseArgs(['frobnicate'], '/b').command).toBe('help')
    expect(parseArgs([], '/b').command).toBe('tui')
  })

  it('parses provider/config selection for headless chat', () => {
    const parsed = parseArgs(['chat', '--provider', 'ds', '--config', '/tmp/c.json', 'hi'], '/base')
    expect(parsed.chat).toMatchObject({ provider: 'ds', config: '/tmp/c.json', prompt: 'hi' })
    expect(parseArgs(['chat', '--config', 'a', '--no-config', 'hi'], '/b').error).toMatch(/Cannot combine/)
  })

  it('parses version', () => {
    expect(parseArgs(['version']).command).toBe('version')
  })

  it('help documents the exit-code contract', () => {
    expect(helpText()).toContain('Exit codes')
    expect(helpText()).toContain('JANUS_API_KEY')
  })
})

describe('runChat', () => {
  it('returns 2 with an actionable error when model config is missing', async () => {
    const errors: string[] = []
    const code = await runChat(
      { workspace: tmpdir(), prompt: 'hi' },
      { env: {}, stderr: (line) => { errors.push(line) } },
    )
    expect(code).toBe(2)
    expect(errors.join('\n')).toMatch(/JANUS_MODEL|JANUS_API_KEY/)
  })

  it('returns 2 for chat without an api key', async () => {
    const errors: string[] = []
    const code = await runChat(
      { workspace: tmpdir(), model: 'm', prompt: 'hi' },
      { env: {}, stderr: (line) => { errors.push(line) } },
    )
    expect(code).toBe(2)
    expect(errors.join('\n')).toContain('JANUS_API_KEY')
  })

  it('returns 2 for a non-directory workspace', async () => {
    const errors: string[] = []
    const code = await runChat(
      { workspace: join(tmpdir(), 'janus-cli-nope-404'), prompt: 'hi' },
      { env: { JANUS_MODEL: 'm', JANUS_API_KEY: 'k' }, stderr: (line) => { errors.push(line) } },
    )
    expect(code).toBe(2)
    expect(errors.join('\n')).toMatch(/not a directory/)
  })

  it('runs a text turn on the stub transport and streams JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-cli-chat-'))
    const lines: string[] = []
    const code = await runChat(
      { workspace: dir, model: 'm', apiKey: 'k', prompt: 'hi' },
      {
        env: {},
        stdout: (line) => { lines.push(line) },
        stderr: () => undefined,
        streamTextFn: async () => ({
          textStream: (async function* () { yield 'hello' })(),
        }),
      },
    )
    expect(code).toBe(0)
    const events = lines.map((line) => JSON.parse(line).event)
    expect(events.some((e) => e.type === 'text_delta' && e.delta === 'hello')).toBe(true)
    expect(events.at(-1)?.type).toBe('stream_end')
  })

  it('honors an explicit --config catalog for provider/model defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-cli-cfg-'))
    const cfgPath = join(mkdtempSync(join(tmpdir(), 'janus-cli-cfgfile-')), 'config.json')
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      providers: [{ id: 'ds', modelId: 'm-ds' }],
      defaultProvider: 'ds',
    }))
    const lines: string[] = []
    const code = await runChat(
      { workspace: dir, config: cfgPath, prompt: 'hi' },
      {
        env: { JANUS_API_KEY: 'k' },
        stdout: (line) => { lines.push(line) },
        stderr: () => undefined,
        authPath: null,
        streamTextFn: async () => ({
          textStream: (async function* () { yield 'hello' })(),
        }),
      },
    )
    expect(code).toBe(0)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('executes real workspace tools through the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-cli-tools-'))
    writeFileSync(join(dir, 'hello.txt'), 'tool-content-here')
    const lines: string[] = []
    let calls = 0
    const code = await runChat(
      { workspace: dir, model: 'm', apiKey: 'k', prompt: 'read hello.txt' },
      {
        env: {},
        stdout: (line) => { lines.push(line) },
        stderr: () => undefined,
        streamTextFn: (async () => {
          calls += 1
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
        }) as never,
      },
    )
    expect(code).toBe(0)
    const text = lines.map((line) => JSON.parse(line)).map((row) => JSON.stringify(row.event)).join('\n')
    expect(text).toContain('workspace')
    expect(lines.map((line) => JSON.parse(line).event).filter((e) => e.type === 'text_delta').map((e) => e.delta).join('')).toContain('saw it')
  })
})
