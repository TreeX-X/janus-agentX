/**
 * Composer pure logic: completion filter/apply, buffer ops, cursor math,
 * and the visible-row window. No React/Ink.
 */
import { describe, expect, it } from 'vitest'
import {
  BREATH_COLORS,
  BREATH_HIGH,
  BREATH_LOW,
  BREATH_MS,
  BREATH_STEPS,
  breathColor,
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_ROWS,
  COMMAND_COMPLETIONS,
  applyCompletion,
  completeSlashCommand,
  completionsCoverKnownCommands,
  cursorLineOf,
  deleteBackward,
  deleteForward,
  displayWidth,
  filterCompletions,
  firstToken,
  insertText,
  offsetOfLine,
  padToWidth,
  resolveComposerWindow,
  sliceAroundCursor,
  truncateToWidth,
  visibleStart,
} from '../src/tui/composer-state.js'
import { isLiveTerminal, restoreNativeCaret } from '../src/tui/terminal-size.js'
import { isKnownCommand, KNOWN_COMMAND_NAMES } from '../src/commands.js'

describe('filterCompletions', () => {
  it('lists every command for a bare slash', () => {
    expect(filterCompletions('/', 1)).toHaveLength(COMMAND_COMPLETIONS.length)
  })

  it('matches by prefix, case-insensitively', () => {
    expect(filterCompletions('/mo', 3).map((item) => item.name)).toEqual(['model'])
    expect(filterCompletions('/MODEL', 6).map((item) => item.name)).toEqual(['model'])
    expect(filterCompletions('/e', 2).map((item) => item.name)).toEqual(['effort', 'exit'])
    expect(filterCompletions('/x', 2)).toEqual([])
  })

  it('covers the latest commands (effort/connect/status)', () => {
    for (const name of ['effort', 'connect', 'status']) {
      expect(filterCompletions(`/${name.slice(0, 2)}`, 3).map((item) => item.name)).toContain(name)
    }
  })

  it('stays inactive for plain text, past-command args, and multiline', () => {
    expect(filterCompletions('hello', 5)).toEqual([])
    expect(filterCompletions('/new x', 6)).toEqual([])
    expect(filterCompletions('/mo\nnext', 3)).toEqual([])
    // Cursor past the token (e.g. after args) is not completing.
    expect(filterCompletions('/model m', 8)).toEqual([])
  })
})

describe('applyCompletion', () => {
  it('replaces the token and leaves a trailing space', () => {
    const model = COMMAND_COMPLETIONS.find((item) => item.name === 'model')!
    expect(applyCompletion('/mo', model)).toEqual({ value: '/model ', cursor: 7 })
  })

  it('keeps existing args after the token', () => {
    const model = COMMAND_COMPLETIONS.find((item) => item.name === 'model')!
    expect(applyCompletion('/mo  m2', model)).toEqual({ value: '/model m2', cursor: 7 })
  })
})

describe('insertText', () => {
  it('inserts at the cursor', () => {
    expect(insertText('ac', 1, 'b')).toEqual({ value: 'abc', cursor: 2 })
  })

  it('normalizes pasted line endings to newlines', () => {
    expect(insertText('', 0, 'a\r\nb\rc')).toEqual({ value: 'a\nb\nc', cursor: 5 })
  })

  it('drops stray control characters but keeps tab', () => {
    expect(insertText('', 0, 'a\x01\tb')).toEqual({ value: 'a\tb', cursor: 3 })
  })

  it('clamps out-of-range cursors', () => {
    expect(insertText('ab', 99, 'c')).toEqual({ value: 'abc', cursor: 3 })
  })
})

describe('deleteBackward/deleteForward', () => {
  it('handles edges without moving past bounds', () => {
    expect(deleteBackward('', 0)).toEqual({ value: '', cursor: 0 })
    expect(deleteBackward('ab', 1)).toEqual({ value: 'b', cursor: 0 })
    expect(deleteForward('ab', 2)).toEqual({ value: 'ab', cursor: 2 })
    expect(deleteForward('ab', 0)).toEqual({ value: 'b', cursor: 0 })
    // Newline deletes like any other char.
    expect(deleteBackward('a\nb', 2)).toEqual({ value: 'ab', cursor: 1 })
  })
})

describe('cursorLineOf/offsetOfLine', () => {
  it('round-trips across lines and clamps columns', () => {
    const value = 'ab\ncdef\ng'
    expect(cursorLineOf(value, 0)).toEqual({ line: 0, column: 0 })
    expect(cursorLineOf(value, 3)).toEqual({ line: 1, column: 0 })
    expect(offsetOfLine(value, 1, 2)).toBe(5)
    expect(cursorLineOf(value, offsetOfLine(value, 2, 9))).toEqual({ line: 2, column: 1 })
  })
})

describe('visibleStart', () => {
  it('pins the window so the cursor stays visible', () => {
    expect(visibleStart(2, 0)).toBe(0)
    expect(visibleStart(COMPOSER_MAX_ROWS + 2, 0)).toBe(0)
    expect(visibleStart(COMPOSER_MAX_ROWS + 2, COMPOSER_MAX_ROWS + 1)).toBe(2)
    expect(COMPOSER_MIN_ROWS).toBeLessThan(COMPOSER_MAX_ROWS)
  })
})

describe('displayWidth/padToWidth/truncateToWidth', () => {
  it('counts CJK as double width and pads exactly', () => {
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('a中b')).toBe(4)
    expect(displayWidth(padToWidth('a中', 6))).toBe(6)
    expect(padToWidth('ab', 5)).toBe('ab   ')
  })

  it('truncates by cells with an ellipsis', () => {
    expect(truncateToWidth('abcdef', 5)).toBe('abcd…')
    expect(truncateToWidth('中文测试', 5)).toBe('中文…')
    expect(truncateToWidth('ab', 5)).toBe('ab')
  })

  it('matches the terminal ruler on emoji sequences (no cursor drift)', () => {
    // Same `string-width` Ink lays out with: the old hand-rolled table was
    // off by 1–6 cells here, parking the real cursor away from the text.
    expect(displayWidth('👍🏽')).toBe(2)
    expect(displayWidth('1️⃣')).toBe(2)
    expect(displayWidth('🀄')).toBe(2)
    expect(displayWidth('👨‍👩‍👧‍👦')).toBe(2)
    expect(displayWidth('é')).toBe(1)
    expect(displayWidth('⚠️')).toBe(2)
  })
})

describe('sliceAroundCursor', () => {
  it('keeps short lines whole', () => {
    expect(sliceAroundCursor('abc', 10, 1)).toEqual({ text: 'abc', cursor: 1 })
  })

  it('shows the head when the cursor fits', () => {
    expect(sliceAroundCursor('abcdefgh', 5, 2)).toEqual({ text: 'abcd…', cursor: 2 })
  })

  it('shows a tail ending at a far cursor', () => {
    const sliced = sliceAroundCursor('abcdefgh', 5, 8)
    expect(sliced.text).toBe('…fgh')
    expect(sliced.cursor).toBe(4)
    // Tail (4 cells) plus the end-of-line cursor block fits the width.
    expect(displayWidth(sliced.text) + 1).toBeLessThanOrEqual(5)
    expect(sliced.cursor).toBe([...sliced.text].length)
  })

  it('reserves a cell for an end-of-line cursor on long lines', () => {
    const sliced = sliceAroundCursor('abcdef', 5, 6)
    expect(displayWidth(sliced.text) + 1).toBeLessThanOrEqual(5)
    expect(sliced.cursor).toBe([...sliced.text].length)
  })
})

describe('completion coverage', () => {
  it('covers every known slash command', () => {
    expect(completionsCoverKnownCommands()).toBe(true)
    for (const item of COMMAND_COMPLETIONS) {
      expect(isKnownCommand(item.name)).toBe(true)
    }
    for (const name of KNOWN_COMMAND_NAMES) {
      expect(COMMAND_COMPLETIONS.some((item) => item.name === name)).toBe(true)
    }
    for (const name of ['help', 'model', 'effort', 'provider', 'connect', 'status', 'workspace', 'new', 'switch', 'rename', 'delete', 'approval', 'exit']) {
      expect(COMMAND_COMPLETIONS.some((item) => item.name === name)).toBe(true)
    }
  })

  it('fails when a known command has no completion entry', () => {
    expect(completionsCoverKnownCommands(['help', 'nope-missing'])).toBe(false)
  })
})

describe('completeSlashCommand (plain repl Tab completer)', () => {
  it('completes a leading slash token with trailing space', () => {
    expect(completeSlashCommand('/')).toEqual([
      COMMAND_COMPLETIONS.map((item) => `/${item.name} `),
      '/',
    ])
    expect(completeSlashCommand('/mo')).toEqual([[`/model `], '/mo'])
    expect(completeSlashCommand('/E')).toEqual([[`/effort `, `/exit `], '/E'])
  })

  it('stays inactive past the command token or for plain text', () => {
    expect(completeSlashCommand('hello')).toEqual([[], 'hello'])
    expect(completeSlashCommand('/model m')).toEqual([[], '/model m'])
    expect(completeSlashCommand('')).toEqual([[], ''])
  })
})

describe('resolveComposerWindow', () => {
  it('uses fixed rows when the terminal size is unknown', () => {
    expect(resolveComposerWindow(undefined)).toEqual({ minRows: COMPOSER_MIN_ROWS, maxRows: COMPOSER_MAX_ROWS })
    expect(resolveComposerWindow(0)).toEqual({ minRows: COMPOSER_MIN_ROWS, maxRows: COMPOSER_MAX_ROWS })
  })

  it('derives the window from the live terminal height', () => {
    expect(resolveComposerWindow(30)).toEqual({ minRows: 3, maxRows: 6 })
    expect(resolveComposerWindow(20)).toEqual({ minRows: 3, maxRows: 5 })
    // Tiny terminals collapse so the discussion keeps room.
    expect(resolveComposerWindow(12)).toEqual({ minRows: 1, maxRows: 3 })
    expect(resolveComposerWindow(8)).toEqual({ minRows: 1, maxRows: 2 })
  })
})

describe('breathing caret', () => {
  const channels = (hex: string): number[] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
  const stepOf = (from: string, to: string): number => {
    const a = channels(from)
    const b = channels(to)
    return Math.max(Math.abs(b[0]! - a[0]!), Math.abs(b[1]! - a[1]!), Math.abs(b[2]! - a[2]!))
  }

  it('ping-pongs dim to bright and back with no wrap jump', () => {
    expect(BREATH_COLORS).toHaveLength(2 * BREATH_STEPS - 2)
    expect(BREATH_COLORS[0]).toBe(BREATH_LOW)
    expect(BREATH_COLORS[BREATH_STEPS - 1]).toBe(BREATH_HIGH)
    // Loop structure: the down-ramp mirrors the up-ramp (dim appears once).
    expect([...BREATH_COLORS.slice(BREATH_STEPS)]).toEqual(
      [...BREATH_COLORS.slice(1, BREATH_STEPS - 1)].reverse(),
    )
    // Wrap edge (last → first) is one small step down: no visible jump.
    expect(stepOf(BREATH_COLORS[BREATH_COLORS.length - 1]!, BREATH_COLORS[0]!)).toBeLessThanOrEqual(40)
  })

  it('steps smoothly (breathing, not blinking)', () => {
    const channels = (hex: string): number[] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ]
    for (let index = 1; index < BREATH_COLORS.length; index += 1) {
      const prev = channels(BREATH_COLORS[index - 1]!)
      const next = channels(BREATH_COLORS[index]!)
      for (let channel = 0; channel < 3; channel += 1) {
        // Small per-tick deltas: a gentle pulse, never a hard toggle.
        expect(Math.abs(next[channel]! - prev[channel]!)).toBeLessThanOrEqual(40)
      }
    }
    expect(BREATH_MS).toBeGreaterThanOrEqual(50)
    expect(BREATH_MS).toBeLessThanOrEqual(500)
  })

  it('wraps arbitrary phases onto the palette', () => {
    expect(breathColor(0)).toBe(BREATH_LOW)
    expect(breathColor(BREATH_STEPS - 1)).toBe(BREATH_HIGH)
    expect(breathColor(BREATH_COLORS.length)).toBe(breathColor(0))
    expect(breathColor(-1)).toBe(breathColor(BREATH_COLORS.length - 1))
  })
})

describe('native cursor gating', () => {
  it('restores visibility only on live TTYs, never pipes or test doubles', () => {
    const writes: string[] = []
    restoreNativeCaret({ isTTY: true, write: (data: string): void => { writes.push(data) } })
    expect(writes).toEqual(['\x1b[?25h'])

    const captured: string[] = []
    const fake = { write: (data: string): void => { captured.push(data) } }
    restoreNativeCaret(fake)
    restoreNativeCaret(undefined)
    expect(captured).toEqual([])
    expect(isLiveTerminal({ isTTY: true, write: () => undefined })).toBe(true)
    expect(isLiveTerminal({ write: () => undefined })).toBe(false)
    expect(isLiveTerminal(undefined)).toBe(false)
  })
})
