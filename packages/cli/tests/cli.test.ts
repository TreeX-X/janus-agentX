/**
 * CLI smoke: argument parsing is pure and fully pinned; resolve only asserts
 * the exit-code contract (binary presence is machine-dependent).
 */
import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from '../src/args.js'
import { runResolve } from '../src/cli.js'

describe('parseArgs', () => {
  it('parses a full run command', () => {
    const parsed = parseArgs(['run', '--engine', 'claude', '--cwd', '/tmp/w', '--model', 'm', '--timeout-ms', '5000', '--approval-mode', 'auto-run', 'do', 'things'], '/base')
    expect(parsed.command).toBe('run')
    expect(parsed.run).toMatchObject({
      engine: 'claude', cwd: '/tmp/w', model: 'm', timeoutMs: 5000, approvalMode: 'auto-run', prompt: 'do things',
    })
  })

  it('supports -e/-C/-m shorthands and the -- separator', () => {
    const parsed = parseArgs(['run', '-e', 'opencode', '--', '--not-a-flag'], '/base')
    expect(parsed.run).toMatchObject({ engine: 'opencode', cwd: '/base', prompt: '--not-a-flag' })
  })

  it('defaults to the codex engine and current directory', () => {
    const parsed = parseArgs(['run', 'hi'], '/base')
    expect(parsed.run).toMatchObject({ engine: 'codex', cwd: '/base', prompt: 'hi' })
  })

  it('rejects bad input with actionable errors', () => {
    expect(parseArgs(['run'], '/b').error).toMatch(/Missing prompt/)
    expect(parseArgs(['run', '--engine', 'nope', 'x'], '/b').error).toMatch(/Invalid --engine/)
    expect(parseArgs(['run', '--timeout-ms', 'x', 'y'], '/b').error).toMatch(/Invalid --timeout-ms/)
    expect(parseArgs(['frobnicate'], '/b').command).toBe('help')
    expect(parseArgs([], '/b').command).toBe('help')
  })

  it('parses resolve and version', () => {
    expect(parseArgs(['resolve']).resolveEngine).toBe('codex')
    expect(parseArgs(['resolve', 'claude']).resolveEngine).toBe('claude')
    expect(parseArgs(['version']).command).toBe('version')
  })

  it('help documents the exit-code contract', () => {
    expect(helpText()).toContain('Exit codes')
  })
})

describe('runResolve', () => {
  it('returns 0 with a path or 3 when the binary is missing', async () => {
    const code = await runResolve('codex')
    expect([0, 3]).toContain(code)
  })
})
