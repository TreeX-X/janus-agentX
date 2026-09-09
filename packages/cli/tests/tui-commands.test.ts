/**
 * Slash-command parsing is pure: commands vs chat input vs empty.
 */
import { describe, expect, it } from 'vitest'
import { commandHelpText, isKnownCommand, parseInputLine } from '../src/commands.js'

describe('parseInputLine', () => {
  it('treats plain text as chat input', () => {
    expect(parseInputLine('  hello world  ')).toEqual({ kind: 'input', text: 'hello world' })
  })

  it('treats blank lines as empty', () => {
    expect(parseInputLine('   ')).toEqual({ kind: 'empty' })
    expect(parseInputLine('/')).toEqual({ kind: 'empty' })
  })

  it('parses known commands case-insensitively with args', () => {
    expect(parseInputLine('/HELP')).toMatchObject({ kind: 'command', command: 'help', known: true, args: [] })
    expect(parseInputLine('/model gpt-4o')).toMatchObject({ kind: 'command', command: 'model', known: true, args: ['gpt-4o'] })
    expect(parseInputLine('/status')).toMatchObject({ kind: 'command', command: 'status', known: true })
    expect(parseInputLine('/connect ds')).toMatchObject({ kind: 'command', command: 'connect', known: true, args: ['ds'] })
    expect(parseInputLine('/workspace  C:\\tmp\\w ')).toMatchObject({ kind: 'command', command: 'workspace', known: true, args: ['C:\\tmp\\w'] })
  })

  it('marks staged and unknown commands distinctly', () => {
    expect(parseInputLine('/switch abc')).toMatchObject({ kind: 'command', command: 'switch', known: true })
    expect(parseInputLine('/frobnicate')).toMatchObject({ kind: 'command', command: 'frobnicate', known: false })
  })

  it('exposes known-command checks and help', () => {
    expect(isKnownCommand('clear')).toBe(true)
    expect(isKnownCommand('nope')).toBe(false)
    expect(commandHelpText()).toContain('/exit')
    expect(commandHelpText()).toContain('/key')
    expect(commandHelpText()).toContain('/status')
    expect(commandHelpText()).toContain('/connect')
    expect(commandHelpText()).toContain('Ctrl+C')
  })
})
