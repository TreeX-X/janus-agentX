/**
 * @file Line-based scroll viewport for the Ink TUI (no React/Ink, unit tested).
 * @description Why this exists: the discussion used to page by whole timeline
 * blocks (`PgUp` hid 5 blocks), so a single long assistant reply — the common
 * case after a task finishes — counted as ONE block and could not be scrolled
 * at all, and the mouse wheel did nothing. Reference behavior:
 * - opencode renders the transcript in a `scrollbox` with `scroll_speed: 3`
 *   lines per wheel tick and `PgUp/PgDn` paging, capturing the wheel via SGR
 *   mouse reporting (`tui.mouse`, default on).
 * - pi fullscreen keeps an internal `viewportTop` + `followOutput` (streaming
 *   never yanks a scrolled-up view), `wheelScrollLines` (default 1, previously
 *   3), `PgUp/PgDn/Home/End` keys, and optional SGR capture
 *   (`\x1b[?1000h\x1b[?1006h`, wheel = button 64 up / 65 down).
 * This module ports that shape to Ink: wrapped-line heights (CJK-aware, same
 * `string-width` ruler Ink lays out with), SGR/legacy wheel parsing for the
 * raw sequences Ink's `useInput` otherwise surfaces as text, and a
 * head+tail-clipped line window so any slice of history — including the middle
 * of one long reply — can be paged while new input re-follows the tail.
 */
import { displayWidth } from './composer-state.js'
import type { TimelineBlock } from './store.js'

/** Lines per mouse-wheel tick (opencode `scroll_speed` / pi `mouseWheelScrollRows`). */
export const WHEEL_SCROLL_LINES = 3
/** Lines per Ctrl+Up / Ctrl+Down step (conflict-free: the composer ignores ctrl). */
export const LINE_SCROLL_LINES = 3
/** Minimum viewport rows so paging never stalls on tiny terminals. */
export const MIN_VIEWPORT_ROWS = 1

/** SGR extended mouse: `\x1b[< Cb ; Cx ; Cy M/m` (Ink strips the leading ESC). */
const SGR_MOUSE_RE = /\[<(\d+);(\d+);(\d+)([mM])/g
/** Legacy X10 mouse: `\x1b[M` + 3 raw bytes (Ink strips the leading ESC). */
const X10_MOUSE_RE = /\[M([\s\S]{3})/g
/** Trailing fragment of a sequence split across stdin chunks (`[<65;1`). */
const SGR_LEAD_FRAGMENT_RE = /\[<\d{1,3}(;\d{0,4}){0,2}$/

/**
 * SGR mouse enable/disable (pi read-mode shape): button tracking (clicks +
 * wheel) plus button-motion drag tracking, with SGR extended encoding.
 * `1002` (not `1003` any-motion: hover motion would only add noise) routes
 * drags into the app so selection is content-constrained by construction —
 * under capture there is no native selection to grab frame chrome. Capture
 * stays opt-in (`shouldCaptureMouse`): by default the terminal owns the
 * mouse and plain drag selects natively.
 */
export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
export const MOUSE_DISABLE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l'

export function isMouseCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['JANUS_NO_MOUSE'] === '1'
}

/**
 * Mouse capture is opt-in: by default the terminal owns the mouse, so plain
 * drag box-selects natively and copy/paste stay terminal-native. `JANUS_MOUSE=1`
 * takes capture for wheel scrolling (tmux needs `mouse on`); `JANUS_NO_MOUSE=1`
 * keeps forcing it off and wins on conflict.
 */
export function shouldCaptureMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['JANUS_NO_MOUSE'] === '1') return false
  return env['JANUS_MOUSE'] === '1'
}

interface TTYGatedStream {
  isTTY?: unknown
  write: (data: string) => unknown
  on?: (event: 'resize', listener: () => void) => unknown
  off?: (event: 'resize', listener: () => void) => unknown
}

/** A host can recreate its emulator without restarting the PTY process. */
export function maintainMouseReporting(stdout: TTYGatedStream): () => void {
  if (stdout.isTTY !== true) return () => undefined
  const restore = () => enableMouseReporting(stdout)
  restore()
  stdout.on?.('resize', restore)
  // Reassert even when an idle/recreated host keeps the same dimensions.
  const timer = setInterval(restore, 2000)
  timer.unref()
  return () => {
    clearInterval(timer)
    stdout.off?.('resize', restore)
    disableMouseReporting(stdout)
  }
}

/** Write SGR mouse reporting on. No-op unless `stdout` is a live TTY. */
export function enableMouseReporting(stdout: TTYGatedStream | undefined | null): void {
  if (!stdout || (stdout as { isTTY?: boolean }).isTTY !== true) return
  try {
    stdout.write(MOUSE_ENABLE)
  } catch {
    // Best effort: a missed mode write must not break startup.
  }
}

/** Write SGR mouse reporting off. No-op unless `stdout` is a live TTY. */
export function disableMouseReporting(stdout: TTYGatedStream | undefined | null): void {
  if (!stdout || (stdout as { isTTY?: boolean }).isTTY !== true) return
  try {
    stdout.write(MOUSE_DISABLE)
  } catch {
    // Best effort: teardown must not fail.
  }
}

function isWheelButton(button: number): 'up' | 'down' | null {
  // Bit 6 marks wheel events; bit 0 is the direction (0 = up, 1 = down).
  // Higher bits carry shift/meta/ctrl modifiers — masked out by the bit test.
  if ((button & 64) === 0) return null
  return (button & 1) === 0 ? 'up' : 'down'
}

/**
 * Net wheel scroll lines in one Ink `useInput` chunk (negative = up,
 * positive = down). Handles coalesced sequences (fast wheels arrive batched)
 * in both SGR and legacy X10 encodings; returns 0 for clicks/moves/text.
 */
export type SgrMouseKind = 'press' | 'drag' | 'release' | 'wheel'

export interface SgrMouseEvent {
  kind: SgrMouseKind
  /** 0 left, 1 middle, 2 right (wheel reports 0 plus a direction). */
  button: number
  direction?: 'up' | 'down'
  /** 1-based terminal cells. */
  x: number
  y: number
  shift: boolean
  meta: boolean
  ctrl: boolean
}

const SGR_EVENT_RE = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/g

/**
 * Every SGR mouse event in one Ink `useInput` chunk (coalesced drags arrive
 * batched). Wheel, press, button-motion drag and release share the `Cb`
 * low bits (button), bit 5 (motion) and bit 6 (wheel); the `m` suffix marks
 * release. Legacy X10 bytes stay with `parseWheelDelta`/`containsMouseSequence`.
 */
export function parseSgrMouseEvents(input: string): SgrMouseEvent[] {
  if (!input || !input.includes('[<')) return []
  const events: SgrMouseEvent[] = []
  SGR_EVENT_RE.lastIndex = 0
  for (let match = SGR_EVENT_RE.exec(input); match !== null; match = SGR_EVENT_RE.exec(input)) {
    const code = Number.parseInt(match[1] ?? '', 10)
    const x = Number.parseInt(match[2] ?? '', 10)
    const y = Number.parseInt(match[3] ?? '', 10)
    if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1) continue
    const mods = { shift: (code & 4) !== 0, meta: (code & 8) !== 0, ctrl: (code & 16) !== 0 }
    const wheel = isWheelButton(code)
    if (wheel) {
      events.push({ kind: 'wheel', button: 0, direction: wheel, x, y, ...mods })
      continue
    }
    if ((match[4] ?? '') === 'm') {
      events.push({ kind: 'release', button: code & 3, x, y, ...mods })
      continue
    }
    if ((code & 32) !== 0) {
      events.push({ kind: 'drag', button: code & 3, x, y, ...mods })
      continue
    }
    events.push({ kind: 'press', button: code & 3, x, y, ...mods })
  }
  return events
}

export interface CprPosition {
  row: number
  col: number
}

const CPR_RE = /\[(\d+);(\d+)R/g

/**
 * Cursor-position replies (`\x1b[{row};{col}R`) answering a `CPR_QUERY`.
 * Callers must only honor these against a pending query — the byte shape
 * can theoretically occur in pasted text.
 */
export function parseCprReplies(input: string): CprPosition[] {
  if (!input || !input.includes('R')) return []
  const out: CprPosition[] = []
  CPR_RE.lastIndex = 0
  for (let match = CPR_RE.exec(input); match !== null; match = CPR_RE.exec(input)) {
    const row = Number.parseInt(match[1] ?? '', 10)
    const col = Number.parseInt(match[2] ?? '', 10)
    if (Number.isFinite(row) && Number.isFinite(col) && row >= 1 && col >= 1) out.push({ row, col })
  }
  return out
}

/** Device-status query whose reply (`parseCprReplies`) anchors mouse cells. */
export const CPR_QUERY = '\x1b[6n'

export function parseWheelDelta(input: string): number {
  if (!input || (!input.includes('[<') && !input.includes('[M'))) return 0
  let delta = 0
  SGR_MOUSE_RE.lastIndex = 0
  for (let match = SGR_MOUSE_RE.exec(input); match !== null; match = SGR_MOUSE_RE.exec(input)) {
    const direction = isWheelButton(Number.parseInt(match[1] ?? '', 10))
    if (direction === 'up') delta -= WHEEL_SCROLL_LINES
    else if (direction === 'down') delta += WHEEL_SCROLL_LINES
  }
  X10_MOUSE_RE.lastIndex = 0
  for (let match = X10_MOUSE_RE.exec(input); match !== null; match = X10_MOUSE_RE.exec(input)) {
    const button = (match[1]?.charCodeAt(0) ?? 0) - 32
    const direction = isWheelButton(button)
    if (direction === 'up') delta -= WHEEL_SCROLL_LINES
    else if (direction === 'down') delta += WHEEL_SCROLL_LINES
  }
  return delta
}

/**
 * True when an Ink `useInput` chunk carries mouse reporting (full sequence or
 * a split-sequence lead fragment). The composer must swallow these: Ink 7 has
 * no mouse parser, so without this guard wheel/click bytes would be inserted
 * as literal text.
 */
export function containsMouseSequence(input: string): boolean {
  if (!input) return false
  SGR_MOUSE_RE.lastIndex = 0
  if (SGR_MOUSE_RE.test(input)) return true
  X10_MOUSE_RE.lastIndex = 0
  if (X10_MOUSE_RE.test(input)) return true
  return SGR_LEAD_FRAGMENT_RE.test(input)
}

/** Chop one paragraph into `width`-sized visual lines (CJK-aware). */
export function wrapVisualLines(paragraph: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  if (paragraph === '') return ['']
  const lines: string[] = []
  let current = ''
  let used = 0
  for (const char of paragraph) {
    const charWidth = Math.max(1, displayWidth(char))
    if (used + charWidth > safeWidth && current !== '') {
      lines.push(current)
      current = ''
      used = 0
    }
    current += char
    used += charWidth
  }
  lines.push(current)
  return lines
}

/** Visual (wrapped) lines of a possibly multiline text at `width` cells. */
export function toVisualLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    out.push(...wrapVisualLines(paragraph, width))
  }
  return out
}

/** Keep visual lines `[skip, skip + take)` of a text, re-joined for Ink. */
export function sliceVisualLines(text: string, width: number, skip: number, take: number): string {
  if (take <= 0) return ''
  const lines = toVisualLines(text, width)
  const safeSkip = Math.max(0, Math.min(skip, lines.length))
  return lines.slice(safeSkip, safeSkip + Math.max(0, take)).join('\n')
}

/**
 * Estimated rendered rows of one timeline block at `width` cells, mirroring
 * `TimelineRow` in `App.tsx` (header + wrapped body + previews + the
 * `marginBottom={1}` spacer). `notice` blocks are excluded upstream and only
 * listed here for completeness.
 */
export function blockLineHeight(block: TimelineBlock, width: number, thinkingExpanded: boolean): number {
  const safeWidth = Math.max(10, Math.floor(width))
  switch (block.kind) {
    case 'notice':
      return toVisualLines(block.text, safeWidth).length + 2
    case 'user':
      return 1 + toVisualLines(block.text, safeWidth).length + 1
    case 'assistant':
      return 1 + toVisualLines(block.text, safeWidth).length + 1
    case 'info':
    case 'error':
      return toVisualLines(block.text, safeWidth).length + 1
    case 'thinking': {
      if (!thinkingExpanded) return 1 + 1
      return 1 + toVisualLines(block.text, safeWidth).length + 1
    }
    case 'tool': {
      const summary = block.toolSummary ? 1 : 0
      const preview = (block.toolPreview ?? []).reduce(
        (count, line) => count + toVisualLines(`    ${line}`, safeWidth).length,
        0,
      )
      return 1 + summary + preview + 1
    }
    default:
      return 1 + toVisualLines(block.text, safeWidth).length + 1
  }
}

/** Total rendered rows of the visible timeline (notices excluded upstream). */
export function totalTimelineLines(
  blocks: TimelineBlock[],
  width: number,
  thinkingExpanded: boolean,
): number {
  return blocks.reduce((sum, block) => sum + blockLineHeight(block, width, thinkingExpanded), 0)
}

/**
 * Discussion viewport rows: terminal height minus the pinned chrome
 * (header 3 + discussion margins 2 + composer frame + footer 2 + Ink's
 * trailing newline 1). The composer frame is `maxRows + 2` borders; the
 * completion popup only borrows discussion space, never adds chrome.
 */
export function estimateViewportRows(termRows: number | undefined, composerMaxRows: number): number {
  const rows = termRows == null || !Number.isFinite(termRows) || termRows <= 0 ? 24 : Math.floor(termRows)
  const chrome = 3 + 2 + (Math.max(1, composerMaxRows) + 2) + 2 + 1
  return Math.max(MIN_VIEWPORT_ROWS, rows - chrome)
}

/** Page step: a full viewport minus a 2-line overlap so context is kept. */
export function pageStep(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows) - 2)
}

/** Clamp a tail-hidden line offset: `[0, max(0, totalLines - viewportRows)]`.
 * When the whole timeline fits the viewport there is nothing to scroll (pi
 * `maxScroll = content - viewport` shape), so paging keys and the wheel are
 * a no-op instead of jumping to a one-line view. */
export function clampScrollOffset(offset: number, totalLines: number, viewportRows = 1): number {
  if (!Number.isFinite(offset)) return 0
  const viewport = Math.max(MIN_VIEWPORT_ROWS, Math.floor(viewportRows))
  return Math.max(0, Math.min(Math.floor(offset), Math.max(0, Math.ceil(totalLines) - viewport)))
}

export interface ScrollWindow {
  /** Blocks to render (whole, except text bodies sliced to the window). */
  blocks: TimelineBlock[]
  /** Total rendered rows of the full timeline. */
  totalLines: number
  /** First visible line (0-based, inclusive) within the full timeline. */
  startLine: number
  /** Last visible line (exclusive) within the full timeline. */
  endLine: number
}

const TEXT_SLICABLE = new Set(['user', 'assistant', 'thinking', 'info', 'error'])

/**
 * Line window `[total - viewport - offset, total - offset)` over the timeline
 * (`offset = 0` follows the tail). Boundary text blocks are sliced to their
 * intersecting visual lines; short chrome blocks (tool cards) snap whole so
 * their header/summary/preview never tear. Callers only need this when
 * `offset > 0` — follow mode renders everything and lets Ink clip the head.
 */
export function sliceWindow(
  blocks: TimelineBlock[],
  options: { width: number; thinkingExpanded: boolean; viewportRows: number; offset: number },
): ScrollWindow {
  const { width, thinkingExpanded } = options
  const safeWidth = Math.max(10, Math.floor(width))
  const viewport = Math.max(MIN_VIEWPORT_ROWS, Math.floor(options.viewportRows))
  const heights = blocks.map((block) => blockLineHeight(block, safeWidth, thinkingExpanded))
  const totalLines = heights.reduce((sum, height) => sum + height, 0)
  const offset = clampScrollOffset(options.offset, totalLines, viewport)
  const endLine = Math.max(0, totalLines - offset)
  const startLine = Math.max(0, endLine - viewport)

  const visible: TimelineBlock[] = []
  let cursor = 0
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!block) continue
    const height = heights[index] ?? 0
    const blockStart = cursor
    const blockEnd = cursor + height
    cursor = blockEnd
    if (blockEnd <= startLine || blockStart >= endLine) continue
    const skip = Math.max(0, startLine - blockStart)
    const take = Math.min(blockEnd, endLine) - Math.max(blockStart, startLine)
    if (skip === 0 && take >= height) {
      visible.push(block)
      continue
    }
    if (!TEXT_SLICABLE.has(block.kind)) {
      // Chrome blocks stay whole: partial tool cards are worse than a few
      // extra rows (Ink clips the overflow either way).
      visible.push(block)
      continue
    }
    if (block.kind === 'thinking' && !thinkingExpanded) {
      visible.push(block)
      continue
    }
    // Body slice: drop the 1-row header from the math, slice the wrapped
    // body, and re-attach. The trailing margin row belongs to the block end.
    const body = sliceVisualLines(block.text, safeWidth, Math.max(0, skip - 1), take)
    visible.push({ ...block, text: body })
  }
  return { blocks: visible, totalLines, startLine, endLine }
}
