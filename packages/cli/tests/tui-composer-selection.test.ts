/**
 * Composer keyboard selection + clipboard: pure selection ranges, windowed
 * row spans (markers never highlight), and the OSC52/in-app clipboard.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  bufferOffsetAtCell,
  deleteSelection,
  displayWidth,
  expandTabsWithMap,
  offsetOfLine,
  replaceSelection,
  rowSelectionSpan,
  selectedText,
  selectionRange,
  sliceAroundCursor,
  sliceAroundCursorEx,
  splitSelectedText,
} from '../src/tui/composer-state.js'
import {
  OSC52_MAX_BYTES,
  createComposerClipboard,
  osc52CopySequence,
} from '../src/tui/clipboard.js'

describe('selectionRange', () => {
  it('is null without an anchor or when collapsed', () => {
    expect(selectionRange('hello', null, 3)).toBeNull()
    expect(selectionRange('hello', undefined, 3)).toBeNull()
    expect(selectionRange('hello', 3, 3)).toBeNull()
    expect(selectionRange('', null, 0)).toBeNull()
  })

  it('orders reversed anchors and clamps out-of-range ends', () => {
    expect(selectionRange('hello', 1, 4)).toEqual({ start: 1, end: 4 })
    expect(selectionRange('hello', 4, 1)).toEqual({ start: 1, end: 4 })
    expect(selectionRange('hello', 0, 99)).toEqual({ start: 0, end: 5 })
    expect(selectionRange('hello', -4, 2)).toEqual({ start: 0, end: 2 })
  })
})

describe('selectedText/deleteSelection/replaceSelection', () => {
  it('reads, deletes, and replaces the selected range', () => {
    expect(selectedText('hello', 1, 4)).toBe('ell')
    expect(selectedText('hello', 4, 1)).toBe('ell')
    expect(selectedText('hello', null, 4)).toBe('')
    expect(deleteSelection('hello', 1, 4)).toEqual({ value: 'ho', cursor: 1 })
    expect(deleteSelection('hello', 4, 1)).toEqual({ value: 'ho', cursor: 1 })
    expect(replaceSelection('hello', 1, 4, 'X')).toEqual({ value: 'hXo', cursor: 2 })
  })

  it('falls back to plain insert/delete without a selection', () => {
    expect(deleteSelection('ab', null, 1)).toEqual({ value: 'ab', cursor: 1 })
    expect(replaceSelection('ab', null, 1, 'X')).toEqual({ value: 'aXb', cursor: 2 })
  })

  it('normalizes pasted line endings on replace', () => {
    expect(replaceSelection('ab', 0, 2, 'x\r\ny')).toEqual({ value: 'x\ny', cursor: 3 })
  })
})

describe('sliceAroundCursorEx', () => {
  const cases: Array<[string, number, number]> = [
    ['abc', 10, 1],
    ['abcdefgh', 5, 2],
    ['abcdefgh', 5, 8],
    ['abcdef', 5, 6],
    ['ab\ncdefghij', 6, 5],
    ['中文测试长行内容', 6, 5],
  ]

  it('matches sliceAroundCursor text/cursor on every window shape', () => {
    for (const [line, width, col] of cases) {
      expect(sliceAroundCursorEx(line, width, col)).toMatchObject(sliceAroundCursor(line, width, col))
    }
  })

  it('reports window provenance for highlight mapping', () => {
    expect(sliceAroundCursorEx('abc', 10, 1)).toMatchObject({ start: 0, leadingEllipsis: false, trailingEllipsis: false })
    const head = sliceAroundCursorEx('abcdefgh', 5, 2)
    expect(head).toMatchObject({ start: 0, leadingEllipsis: false, trailingEllipsis: true })
    expect(head.text).toBe('abcd…')
    const tail = sliceAroundCursorEx('abcdefgh', 5, 8)
    expect(tail).toMatchObject({ leadingEllipsis: true, trailingEllipsis: false })
    expect(tail.start).toBeGreaterThan(0)
    // Content chars (markers excluded) always cover the cursor column.
    expect(tail.start).toBeLessThanOrEqual(8)
  })
})

describe('expandTabsWithMap', () => {
  it('maps painted chars back to raw offsets', () => {
    const { text, offsets } = expandTabsWithMap('a\tb')
    expect(text).toBe('a  b')
    expect(offsets).toEqual([0, 1, 1, 2])
    expect(offsets).toHaveLength([...text].length)
  })
})

describe('rowSelectionSpan', () => {
  const line = 'hello world'
  const { offsets } = expandTabsWithMap(line)

  it('highlights the intersecting chars of a row', () => {
    const span = rowSelectionSpan({
      expandedOffsets: offsets,
      lineStartOffset: 0,
      selection: { start: 1, end: 4 },
      sliceStart: 0,
      contentLength: line.length,
      leadingEllipsis: false,
    })
    expect(span).toEqual({ from: 1, to: 4 })
    expect(splitSelectedText(line, span)).toEqual(['h', 'ell', 'o world'])
  })

  it('clips to the visible window and skips markers', () => {
    // Tail window `…rld` over `hello world` with cursor at the end.
    const sliced = sliceAroundCursorEx(line, 5, line.length)
    expect(sliced.leadingEllipsis).toBe(true)
    const contentLength = [...sliced.text].length - 1
    const span = rowSelectionSpan({
      expandedOffsets: offsets,
      lineStartOffset: 0,
      selection: { start: 0, end: 11 },
      sliceStart: sliced.start,
      contentLength,
      leadingEllipsis: sliced.leadingEllipsis,
    })
    // Whole visible tail highlights, the leading `…` does not.
    expect(span).toEqual({ from: 1, to: 1 + contentLength })
    const [before, selected, after] = splitSelectedText(sliced.text, span)
    expect(before).toBe('…')
    expect(selected).toBe(sliced.text.slice(1))
    expect(after).toBe('')
  })

  it('returns null off-window or without a selection', () => {
    expect(rowSelectionSpan({
      expandedOffsets: offsets,
      lineStartOffset: 0,
      selection: { start: 0, end: 2 },
      sliceStart: 8,
      contentLength: 3,
      leadingEllipsis: true,
    })).toBeNull()
    expect(rowSelectionSpan({
      expandedOffsets: offsets,
      lineStartOffset: 0,
      selection: null,
      sliceStart: 0,
      contentLength: line.length,
      leadingEllipsis: false,
    })).toBeNull()
  })

  it('maps multiline selections per row via absolute offsets', () => {
    const value = 'ab\ncdef\ng'
    // Select `b\ncde` = absolute [1, 6).
    const selection = selectionRange(value, 1, 6)!
    const first = rowSelectionSpan({
      expandedOffsets: expandTabsWithMap('ab').offsets,
      lineStartOffset: offsetOfLine(value, 0, 0),
      selection,
      sliceStart: 0,
      contentLength: 2,
      leadingEllipsis: false,
    })
    const second = rowSelectionSpan({
      expandedOffsets: expandTabsWithMap('cdef').offsets,
      lineStartOffset: offsetOfLine(value, 1, 0),
      selection,
      sliceStart: 0,
      contentLength: 4,
      leadingEllipsis: false,
    })
    const third = rowSelectionSpan({
      expandedOffsets: expandTabsWithMap('g').offsets,
      lineStartOffset: offsetOfLine(value, 2, 0),
      selection,
      sliceStart: 0,
      contentLength: 1,
      leadingEllipsis: false,
    })
    expect(splitSelectedText('ab', first)).toEqual(['a', 'b', ''])
    expect(splitSelectedText('cdef', second)).toEqual(['', 'cde', 'f'])
    expect(third).toBeNull()
  })
})

describe('bufferOffsetAtCell (constrained mouse mapping)', () => {
  const atCell = (
    rawLine: string,
    displayed: string,
    sliceStart: number,
    leading: boolean,
    cell: number,
  ): number => {
    const trailing = false
    return bufferOffsetAtCell({
      expandedOffsets: expandTabsWithMap(rawLine).offsets,
      lineStartOffset: 0,
      lineLength: rawLine.length,
      displayed,
      sliceStart,
      contentLength: [...displayed].length - (leading ? 1 : 0) - (trailing ? 1 : 0),
      leadingEllipsis: leading,
      cell,
    })
  }

  it('maps cells to offsets on a whole line and clamps the edges', () => {
    expect(atCell('hello world', 'hello world', 0, false, 0)).toBe(0)
    expect(atCell('hello world', 'hello world', 0, false, 1)).toBe(1)
    expect(atCell('hello world', 'hello world', 0, false, 10)).toBe(10)
    // Prompt side clamps to the line start, padding side to the line end.
    expect(atCell('hello world', 'hello world', 0, false, -3)).toBe(0)
    expect(atCell('hello world', 'hello world', 0, false, 99)).toBe(11)
  })

  it('follows a tail window without ever resolving the marker', () => {
    const sliced = sliceAroundCursorEx('hello world', 5, 11)
    expect(sliced.text).toBe('…rld')
    expect(atCell('hello world', sliced.text, sliced.start, true, 1)).toBe(8)
    expect(atCell('hello world', sliced.text, sliced.start, true, 2)).toBe(9)
    expect(atCell('hello world', sliced.text, sliced.start, true, 3)).toBe(10)
    expect(atCell('hello world', sliced.text, sliced.start, true, 9)).toBe(11)
  })

  it('keeps wide chars atomic across their cells', () => {
    // '中' is one UTF-16 unit and two cells: units a=0 中=1 b=2.
    expect(atCell('a中b', 'a中b', 0, false, 0)).toBe(0)
    expect(atCell('a中b', 'a中b', 0, false, 1)).toBe(1)
    expect(atCell('a中b', 'a中b', 0, false, 2)).toBe(1)
    expect(atCell('a中b', 'a中b', 0, false, 3)).toBe(2)
    expect(atCell('a中b', 'a中b', 0, false, 9)).toBe(3)
  })

  it('maps both cells of an expanded tab to the tab offset', () => {
    expect(atCell('a\tb', 'a  b', 0, false, 0)).toBe(0)
    expect(atCell('a\tb', 'a  b', 0, false, 1)).toBe(1)
    expect(atCell('a\tb', 'a  b', 0, false, 2)).toBe(1)
    expect(atCell('a\tb', 'a  b', 0, false, 3)).toBe(2)
  })

  it('returns the line start when there is no content', () => {
    expect(atCell('', '', 0, false, 3)).toBe(0)
  })
})

describe('composer clipboard', () => {
  it('builds a decodable OSC52 sequence', () => {
    const sequence = osc52CopySequence('hi 你好')
    expect(sequence.startsWith('\x1b]52;c;')).toBe(true)
    expect(sequence.endsWith('\x07')).toBe(true)
    const payload = sequence.slice('\x1b]52;c;'.length, -1)
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('hi 你好')
  })

  it('stores every copy and mirrors to a live TTY', () => {
    const write = vi.fn()
    const clipboard = createComposerClipboard({ isTTY: true, write })
    expect(clipboard.copy('hello')).toEqual({ stored: true, viaSystem: true })
    expect(write).toHaveBeenCalledTimes(1)
    expect(clipboard.paste()).toBe('hello')
    expect(clipboard.peek()).toBe('hello')
  })

  it('skips OSC52 off-TTY but keeps the in-app buffer', () => {
    const write = vi.fn()
    const clipboard = createComposerClipboard({ write })
    expect(clipboard.copy('hello')).toEqual({ stored: true, viaSystem: false })
    expect(write).not.toHaveBeenCalled()
    expect(clipboard.paste()).toBe('hello')
  })

  it('ignores empty copies and oversized system writes', () => {
    const clipboard = createComposerClipboard(null)
    expect(clipboard.copy('')).toEqual({ stored: false, viaSystem: false })
    expect(clipboard.paste()).toBe('')
    const write = vi.fn()
    const gated = createComposerClipboard({ isTTY: true, write })
    const big = `x`.repeat(OSC52_MAX_BYTES + 1)
    expect(gated.copy(big)).toEqual({ stored: true, viaSystem: false })
    expect(write).not.toHaveBeenCalled()
    expect(gated.paste()).toBe(big)
  })

  it('survives a throwing stdout', () => {
    const clipboard = createComposerClipboard({
      isTTY: true,
      write: () => { throw new Error('dead tty') },
    })
    expect(clipboard.copy('hello')).toEqual({ stored: true, viaSystem: false })
    expect(clipboard.paste()).toBe('hello')
  })

  it('keeps highlight math honest on wide runes', () => {
    // Sanity anchor: selection spans count buffer chars, display pads cells.
    expect(displayWidth('中文')).toBe(4)
    expect(selectedText('a中文b', 1, 3)).toBe('中文')
  })
})
