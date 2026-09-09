/**
 * Caret-shape ownership: steady block while the TUI runs (opencode-style),
 * terminal default on exit — both TTY-gated so pipes and test doubles are
 * never touched.
 */
import { describe, expect, it } from 'vitest'
import { CARET_BLOCK, CARET_DEFAULT, setCaretShape } from '../src/tui/terminal-size.js'

function fakeStream(isTTY: boolean): { isTTY: boolean; writes: string[]; write: (data: string) => boolean } {
  const writes: string[] = []
  return {
    isTTY,
    writes,
    write: (data: string): boolean => {
      writes.push(data)
      return true
    },
  }
}

describe('caret shape', () => {
  it('writes DECSCUSR sequences on a live TTY', () => {
    const stdout = fakeStream(true)
    setCaretShape(stdout, CARET_BLOCK)
    setCaretShape(stdout, CARET_DEFAULT)
    expect(stdout.writes).toEqual(['\x1b[2 q', '\x1b[0 q'])
    expect(CARET_BLOCK).toBe('\x1b[2 q')
    expect(CARET_DEFAULT).toBe('\x1b[0 q')
  })

  it('writes nothing without a live TTY', () => {
    for (const stdout of [fakeStream(false), undefined, null]) {
      expect(() => setCaretShape(stdout, CARET_BLOCK)).not.toThrow()
    }
    expect(fakeStream(false).writes).toEqual([])
  })
})
