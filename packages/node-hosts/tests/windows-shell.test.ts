/**
 * windows-shell parity tests: sync command.run and background JobManager share
 * one mapping, so a fix on one path cannot silently leave the other behind.
 */
import { describe, expect, it } from 'vitest'
import { commandExecutionMode } from '../src/windows-shell.js'
import { commandExecutionMode as viaCommand } from '../src/command.js'

describe('windows-shell shim mapping', () => {
  it('routes package-manager shims through cmd.exe on win32 only', () => {
    for (const program of ['npm', 'yarn', 'pnpm', 'bun', 'NPM']) {
      expect(commandExecutionMode(program, 'win32')).toBe('windows-shell-shim')
      expect(commandExecutionMode(program, 'linux')).toBe('direct')
    }
    expect(commandExecutionMode('node', 'win32')).toBe('direct')
  })

  it('routes .cmd/.bat programs through cmd.exe on win32 only', () => {
    expect(commandExecutionMode('run.cmd', 'win32')).toBe('windows-shell-shim')
    expect(commandExecutionMode('run.bat', 'win32')).toBe('windows-shell-shim')
    expect(commandExecutionMode('run.cmd', 'linux')).toBe('direct')
  })

  it('stays re-exported from command.js for backward compatibility', () => {
    expect(viaCommand('npm', 'win32')).toBe('windows-shell-shim')
    expect(viaCommand('node', 'win32')).toBe('direct')
  })
})
