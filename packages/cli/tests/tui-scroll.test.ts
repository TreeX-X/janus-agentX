/**
 * Line scroll viewport: wheel parsing, wrapping, windowing — no Ink.
 */
import { describe, expect, it } from 'vitest'
import {
  blockLineHeight,
  clampScrollOffset,
  containsMouseSequence,
  estimateViewportRows,
  isMouseCaptureDisabled,
  LINE_SCROLL_LINES,
  pageStep,
  parseWheelDelta,
  sliceVisualLines,
  sliceWindow,
  totalTimelineLines,
  toVisualLines,
  WHEEL_SCROLL_LINES,
  wrapVisualLines,
} from '../src/tui/scroll.js'
import type { TimelineBlock } from '../src/tui/store.js'

function block(kind: TimelineBlock['kind'], text: string, extra: Partial<TimelineBlock> = {}): TimelineBlock {
  return { id: `t-${kind}-${text.slice(0, 8)}`, kind, text, ...extra }
}

describe('parseWheelDelta', () => {
  it('maps SGR wheel up/down to line steps', () => {
    expect(parseWheelDelta('[<64;10;20M')).toBe(-WHEEL_SCROLL_LINES)
    expect(parseWheelDelta('[<65;10;20M')).toBe(WHEEL_SCROLL_LINES)
    expect(parseWheelDelta('\x1b[<64;10;20M')).toBe(-WHEEL_SCROLL_LINES)
  })

  it('ignores modifiers on wheel buttons (shift/meta/ctrl)', () => {
    expect(parseWheelDelta('[<68;1;1M')).toBe(-WHEEL_SCROLL_LINES)
    expect(parseWheelDelta('[<69;1;1M')).toBe(WHEEL_SCROLL_LINES)
  })

  it('sums coalesced sequences from fast wheels', () => {
    expect(parseWheelDelta('[<64;1;1M[<64;1;1M[<65;1;1M')).toBe(-WHEEL_SCROLL_LINES)
  })

  it('ignores clicks, releases, and plain text', () => {
    expect(parseWheelDelta('[<0;10;20M')).toBe(0)
    expect(parseWheelDelta('[<0;10;20m')).toBe(0)
    expect(parseWheelDelta('hello')).toBe(0)
    expect(parseWheelDelta('')).toBe(0)
    expect(parseWheelDelta('[<3;10;20M')).toBe(0)
  })

  it('parses legacy X10 wheel bytes', () => {
    const up = `[M${String.fromCharCode(32 + 64)}!!`
    const down = `[M${String.fromCharCode(32 + 65)}!!`
    expect(parseWheelDelta(up)).toBe(-WHEEL_SCROLL_LINES)
    expect(parseWheelDelta(down)).toBe(WHEEL_SCROLL_LINES)
    expect(parseWheelDelta(`[M${String.fromCharCode(32 + 0)}!!`)).toBe(0)
  })
})

describe('containsMouseSequence', () => {
  it('detects full and fragmented mouse sequences', () => {
    expect(containsMouseSequence('[<65;10;20M')).toBe(true)
    expect(containsMouseSequence('prefix[<64;1;1M')).toBe(true)
    expect(containsMouseSequence('[<65;1')).toBe(true)
  })

  it('leaves normal typing alone', () => {
    expect(containsMouseSequence('hello')).toBe(false)
    expect(containsMouseSequence('[hello')).toBe(false)
    expect(containsMouseSequence('<')).toBe(false)
    expect(containsMouseSequence('a[<b')).toBe(false)
  })
})

describe('wrapping', () => {
  it('wraps ascii by cells and keeps empty lines', () => {
    expect(wrapVisualLines('abcd', 2)).toEqual(['ab', 'cd'])
    expect(wrapVisualLines('', 10)).toEqual([''])
    expect(toVisualLines('ab\n', 10)).toEqual(['ab', ''])
  })

  it('counts CJK as double width', () => {
    expect(wrapVisualLines('中文ab', 4)).toEqual(['中文', 'ab'])
  })

  it('slices visual line ranges', () => {
    expect(sliceVisualLines('l1\nl2\nl3\nl4', 10, 1, 2)).toBe('l2\nl3')
    expect(sliceVisualLines('l1\nl2', 10, 9, 2)).toBe('')
  })
})

describe('viewport math', () => {
  it('reserves pinned chrome and pages with overlap', () => {
    expect(estimateViewportRows(24, 6)).toBe(24 - (3 + 2 + 8 + 2 + 1))
    expect(estimateViewportRows(undefined, 6)).toBe(estimateViewportRows(24, 6))
    expect(pageStep(8)).toBe(6)
    expect(pageStep(1)).toBe(1)
    expect(clampScrollOffset(-5, 10)).toBe(0)
    expect(clampScrollOffset(99, 10)).toBe(9)
    expect(clampScrollOffset(4, 10)).toBe(4)
    // Viewport-aware (pi maxScroll shape): nothing to scroll when it fits.
    expect(clampScrollOffset(99, 16, 8)).toBe(8)
    expect(clampScrollOffset(5, 10, 20)).toBe(0)
    expect(clampScrollOffset(0, 10, 20)).toBe(0)
  })

  it('exposes the mouse opt-out', () => {
    expect(isMouseCaptureDisabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isMouseCaptureDisabled({ JANUS_NO_MOUSE: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(LINE_SCROLL_LINES).toBeGreaterThan(0)
  })
})

describe('sliceWindow', () => {
  const width = 20

  it('follows the tail at offset 0', () => {
    const blocks = [block('user', 'hi'), block('assistant', 'hello')]
    const total = totalTimelineLines(blocks, width, false)
    const win = sliceWindow(blocks, { width, thinkingExpanded: false, viewportRows: 50, offset: 0 })
    expect(win.totalLines).toBe(total)
    expect(win.startLine).toBe(0)
    expect(win.endLine).toBe(total)
    expect(win.blocks).toHaveLength(2)
  })

  it('slices the middle out of one long reply', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`)
    const blocks = [block('assistant', lines.join('\n'))]
    const total = totalTimelineLines(blocks, width, false)
    // Scrolled up 10 rows with a 5-row viewport: the window covers rows
    // [total-15, total-10) — header row plus body lines, never the whole dump.
    const win = sliceWindow(blocks, { width, thinkingExpanded: false, viewportRows: 5, offset: 10 })
    expect(win.totalLines).toBe(total)
    expect(win.endLine - win.startLine).toBe(5)
    expect(win.blocks).toHaveLength(1)
    expect(win.blocks[0]?.text.split('\n')).toHaveLength(5)
    expect(win.blocks[0]?.text).not.toContain('line-29')
  })

  it('keeps tool cards whole at window edges', () => {
    const blocks = [
      block('assistant', 'before'),
      block('tool', '', { toolName: 't', toolStatus: 'completed', toolPreview: ['+a', '+b'] }),
      block('assistant', 'after'),
    ]
    const total = totalTimelineLines(blocks, width, false)
    const win = sliceWindow(blocks, { width, thinkingExpanded: false, viewportRows: 4, offset: 1 })
    expect(win.totalLines).toBe(total)
    const tool = win.blocks.find((item) => item.kind === 'tool')
    expect(tool?.toolPreview).toEqual(['+a', '+b'])
  })

  it('collapses thinking to one row unless expanded', () => {
    const thinking = block('thinking', 'a\nb\nc')
    expect(blockLineHeight(thinking, width, false)).toBe(2)
    expect(blockLineHeight(thinking, width, true)).toBeGreaterThan(2)
  })
})
