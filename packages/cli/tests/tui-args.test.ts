/**
 * TUI argv parsing: `tui` flags, no-arg default, and chat parity guards.
 */
import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from '../src/args.js'

describe('parseArgs tui', () => {
  it('defaults to tui with no argv', () => {
    const parsed = parseArgs([], '/base')
    expect(parsed.command).toBe('tui')
    expect(parsed.tui).toMatchObject({ workspace: '/base' })
  })

  it('parses a full tui command', () => {
    const parsed = parseArgs(
      ['tui', '--workspace', '/tmp/w', '--model', 'm', '--base-url', 'http://x/v1', '--api-key', 'k',
        '--max-turns', '5', '--timeout-ms', '5000', '--conversation', 'c1',
        '--approval-mode', 'per-action', '--plain'],
      '/base',
    )
    expect(parsed.command).toBe('tui')
    expect(parsed.tui).toMatchObject({
      workspace: '/tmp/w', model: 'm', baseUrl: 'http://x/v1', apiKey: 'k',
      maxTurns: 5, timeoutMs: 5000, conversationId: 'c1',
      approvalMode: 'per-action', plain: true,
    })
  })

  it('accepts -C/-m shorthands and --fullscreen', () => {
    const parsed = parseArgs(['tui', '-C', '/w', '-m', 'm', '--fullscreen'], '/base')
    expect(parsed.tui).toMatchObject({ workspace: '/w', model: 'm', fullscreen: true })
  })

  it('rejects prompt positionals and bad flags', () => {
    expect(parseArgs(['tui', 'hello'], '/b').error).toMatch(/no prompt argument/)
    expect(parseArgs(['tui', '--', 'hello'], '/b').error).toMatch(/no prompt argument/)
    expect(parseArgs(['tui', '--nope'], '/b').error).toMatch(/Unknown flag/)
    expect(parseArgs(['tui', '--approval-mode', 'sometimes'], '/b').error).toMatch(/Invalid --approval-mode/)
  })

  it('keeps chat single-shot: prompt required, auto-run only, no tui-only flags', () => {
    expect(parseArgs(['chat', '--approval-mode', 'per-action', 'y'], '/b').error).toMatch(/Only auto-run/)
    expect(parseArgs(['chat', '--plain', 'y'], '/b').error).toMatch(/only supported by janus tui/)
    expect(parseArgs(['chat', '--fullscreen', 'y'], '/b').error).toMatch(/only supported by janus tui/)
  })

  it('parses provider/config selection flags', () => {
    expect(parseArgs(['tui', '-p', 'deepseek'], '/b').tui).toMatchObject({ provider: 'deepseek' })
    expect(parseArgs(['tui', '--provider', 'oa', '--config', '/tmp/c.json'], '/b').tui)
      .toMatchObject({ provider: 'oa', config: '/tmp/c.json' })
    expect(parseArgs(['tui', '--no-config'], '/b').tui).toMatchObject({ noConfig: true })
    expect(parseArgs(['tui', '--config', 'a', '--no-config'], '/b').error).toMatch(/Cannot combine/)
    expect(parseArgs(['tui', '--provider'], '/b').error).toMatch(/Missing --provider/)
    expect(parseArgs(['tui', '--config'], '/b').error).toMatch(/Missing --config/)
  })

  it('help documents the tui entry', () => {
    expect(helpText()).toContain('janus [tui]')
    expect(helpText()).toContain('Resident interactive loop')
  })
})
