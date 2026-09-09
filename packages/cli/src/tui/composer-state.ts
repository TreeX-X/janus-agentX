/**
 * @file Pure composer logic for the Ink TUI input box (no React/Ink).
 * @description Multiline buffer ops, slash-command completion filtering and
 * application, the visible-row window, the responsive composer window
 * (opencode-style: panel height derives from the live terminal height),
 * and the breathing caret palette (smooth pulse, never a hard blink).
 * The `Composer.tsx` host only renders state and forwards key events here,
 * so every rule is unit tested.
 */
import { isKnownCommand } from '../commands.js'

/** Default visible content rows of the input box (compact but taller than one). */
export const COMPOSER_MIN_ROWS = 3
/** Max visible content rows before the box scrolls to the cursor. */
export const COMPOSER_MAX_ROWS = 6

/**
 * Responsive composer window, opencode-style: the panel grows/shrinks with
 * the live terminal height instead of using fixed row counts. Tiny
 * terminals collapse to a single row so the discussion keeps some room.
 */
export function resolveComposerWindow(termRows: number | undefined): { minRows: number; maxRows: number } {
  if (termRows == null || !Number.isFinite(termRows) || termRows <= 0) {
    return { minRows: COMPOSER_MIN_ROWS, maxRows: COMPOSER_MAX_ROWS }
  }
  return {
    minRows: termRows < 16 ? 1 : COMPOSER_MIN_ROWS,
    maxRows: Math.max(2, Math.min(COMPOSER_MAX_ROWS, Math.floor(termRows / 4))),
  }
}

export interface CompletionItem {
  name: string
  hint: string
}

/** Mirrors the known `/` commands in `commands.ts` (kept in sync by test). */
export const COMMAND_COMPLETIONS: readonly CompletionItem[] = [
  { name: 'help', hint: 'Show this help.' },
  { name: 'model', hint: 'List models or switch the model.' },
  { name: 'provider', hint: 'List providers or switch provider.' },
  { name: 'workspace', hint: 'Switch workspace (history is cleared).' },
  { name: 'clear', hint: 'Clear this conversation history.' },
  { name: 'new', hint: 'Start a conversation (and switch to it).' },
  { name: 'list', hint: 'List conversations (* = active).' },
  { name: 'switch', hint: 'Switch conversation.' },
  { name: 'rename', hint: 'Rename the active conversation.' },
  { name: 'delete', hint: 'Delete a conversation (default: active).' },
  { name: 'approval', hint: 'Show or switch auto-run|per-action.' },
  { name: 'exit', hint: 'Leave janus.' },
]

/** First whitespace-delimited token of the input (the `/` command being typed). */
export function firstToken(value: string): string {
  const match = /^(\S*)/.exec(value)
  return match ? match[1] : ''
}

/**
 * Completion candidates for the current input. Active only while the first
 * token starts with `/` and the cursor is still inside it (single-line).
 */
export function filterCompletions(value: string, cursor: number): CompletionItem[] {
  if (!value.startsWith('/')) return []
  const token = firstToken(value)
  if (cursor > token.length || value.includes('\n')) return []
  const needle = token.slice(1).toLowerCase()
  return COMMAND_COMPLETIONS.filter((item) => item.name.startsWith(needle))
}

/** Replace the first token with the picked command plus a trailing space. */
export function applyCompletion(value: string, item: CompletionItem): { value: string; cursor: number } {
  const rest = value.slice(firstToken(value).length).replace(/^\s*/, '')
  const completed = `/${item.name}`
  const next = rest ? `${completed} ${rest}` : `${completed} `
  return { value: next, cursor: completed.length + 1 }
}

function normalizePastedText(text: string): string {
  // \r\n / lone \r (Windows pastes) become \n; other C0 controls are dropped
  // (except \n and \t, which are legitimate content).
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '')
}

/** Insert text at the cursor (paste-safe: newlines insert, never submit). */
export function insertText(value: string, cursor: number, text: string): { value: string; cursor: number } {
  const safe = Math.max(0, Math.min(cursor, value.length))
  const next = normalizePastedText(text)
  return {
    value: value.slice(0, safe) + next + value.slice(safe),
    cursor: safe + next.length,
  }
}

/** Delete the char before the cursor (Backspace). */
export function deleteBackward(value: string, cursor: number): { value: string; cursor: number } {
  const safe = Math.max(0, Math.min(cursor, value.length))
  if (safe === 0) return { value, cursor: 0 }
  return { value: value.slice(0, safe - 1) + value.slice(safe), cursor: safe - 1 }
}

/** Delete the char after the cursor (Delete). */
export function deleteForward(value: string, cursor: number): { value: string; cursor: number } {
  const safe = Math.max(0, Math.min(cursor, value.length))
  if (safe >= value.length) return { value, cursor: safe }
  return { value: value.slice(0, safe) + value.slice(safe + 1), cursor: safe }
}

export interface CursorLine {
  /** Zero-based line index the cursor sits on. */
  line: number
  /** Column (chars) within that line. */
  column: number
}

/** Map an absolute offset to line/column. */
export function cursorLineOf(value: string, cursor: number): CursorLine {
  const safe = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, safe)
  const line = before.split('\n').length - 1
  const column = safe - (before.lastIndexOf('\n') + 1)
  return { line, column }
}

/** Absolute offset for a line/column (column clamps to the line length). */
export function offsetOfLine(value: string, line: number, column: number): number {
  const lines = value.split('\n')
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
  let offset = 0
  for (let index = 0; index < clampedLine; index += 1) {
    offset += (lines[index] ?? '').length + 1
  }
  return offset + Math.max(0, Math.min(column, (lines[clampedLine] ?? '').length))
}

/**
 * First visible content row so the cursor stays in view inside a
 * `COMPOSER_MAX_ROWS` window.
 */
export function visibleStart(lines: number, cursorLine: number, maxRows: number = COMPOSER_MAX_ROWS): number {
  if (lines <= maxRows) return 0
  return Math.max(0, Math.min(cursorLine - maxRows + 1, lines - maxRows))
}

/** True when every known `/` command has a completion entry. */
export function completionsCoverKnownCommands(): boolean {
  return COMMAND_COMPLETIONS.every((item) => isKnownCommand(item.name))
}

/* ── Display width (Ink-aligned ruler) ─────────────────────────────────
   Cell width MUST use the same ruler Ink's Yoga layout uses (`string-width`,
   via `widest-line` in Ink's `measure-text`). The previous hand-rolled table
   drifted 1–6 cells on emoji ZWJ sequences / skin-tone modifiers / keycaps /
   newer blocks (e.g. U+1F004) and non-covered combining marks — the painted
   text then sat somewhere else than the real cursor, and undercounted wide
   runes could even wrap a row and shift Y. Same guidance as Ink's `useCursor`
   docs ("Use string-width to calculate x") and opencode's renderer-owned
   cursor. */
import stringWidth from 'string-width'

/** Terminal cell width of a string (whole-string: ZWJ/ANSI-aware). */
export function displayWidth(text: string): number {
  return stringWidth(text)
}

/** Pad with spaces to exactly `width` cells (tabs pre-expanded by callers). */
export function padToWidth(text: string, width: number): string {
  const missing = width - displayWidth(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

/** Fit into `width` cells, ending with `…` when cut. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text
  if (width === 1) return '…'
  let used = 0
  let out = ''
  for (const char of text) {
    const w = stringWidth(char)
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return `${out}…`
}

/**
 * Slice a line to `width` cells keeping the cursor visible: head when the
 * cursor fits, otherwise a `…`-led tail ending at the cursor. A cursor at
 * the very end of the line reserves one cell for its block.
 */
export function sliceAroundCursor(line: string, width: number, cursorCol: number): { text: string; cursor: number } {
  const chars = [...line]
  const safe = Math.max(0, Math.min(cursorCol, chars.length))
  const atEnd = safe >= chars.length
  const budget = Math.max(1, atEnd ? width - 1 : width)
  if (displayWidth(line) <= budget) return { text: line, cursor: safe }
  const headWidth = displayWidth(chars.slice(0, safe).join(''))
  if (headWidth <= budget - 1) {
    const head = truncateToWidth(line, budget)
    return { text: head, cursor: Math.min(safe, [...head].length) }
  }
  let used = 1 // leading …
  let start = safe
  while (start > 0) {
    const w = stringWidth(chars[start - 1] ?? '')
    if (used + w > budget) break
    used += w
    start -= 1
  }
  return { text: `…${chars.slice(start, safe).join('')}`, cursor: 1 + (safe - start) }
}

/* ── Native cursor visibility ────────────────────────────────────────────
   The caret itself is painted (see the breathing block below). Mid-run the
   native cursor is hidden through Ink's official `useCursor` channel (see
   `native-cursor.ts`); this constant only restores visibility on the way
   out (`run.tsx`, plus Ink's own teardown). */

export const CURSOR_SHOW = '\x1b[?25h'

/* ── Breathing caret (smooth pulse, never a hard blink) ──────────────────
   Terminals only offer blinking-or-steady native cursors, so the breathing
   glow is painted: the caret cell cycles smoothly between a dim amber and
   the full orange accent and back (ping-pong), one small step per tick.
   Small steps at ~8fps read as breathing; a two-state toggle would read as
   blinking. Inactive (busy/disabled) input uses a steady dim block. */

function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function toHexColor(rgb: [number, number, number]): string {
  const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/** Dim end of the breath. */
export const BREATH_LOW = '#5c4128'
/** Bright end of the breath (matches the JanusX orange accent). */
export const BREATH_HIGH = '#ff7830'
/** Steps from dim to bright; the full cycle ping-pongs back down. */
export const BREATH_STEPS: number = 7
/** Breathing tick: ~8fps, calm and cheap under Ink's 30fps throttle. */
export const BREATH_MS = 130

function lerpColor(low: [number, number, number], high: [number, number, number], t: number): string {
  return toHexColor([
    low[0] + (high[0] - low[0]) * t,
    low[1] + (high[1] - low[1]) * t,
    low[2] + (high[2] - low[2]) * t,
  ])
}

/**
 * Ping-pong palette: dim → … → bright → … → dim. Length is
 * `2 * BREATH_STEPS - 2`, so advancing the phase by one tick loops a full
 * breath with no visible jump at the wrap point.
 */
export const BREATH_COLORS: readonly string[] = (() => {
  const low = parseHexColor(BREATH_LOW)
  const high = parseHexColor(BREATH_HIGH)
  const up: string[] = []
  for (let step = 0; step < BREATH_STEPS; step += 1) {
    up.push(lerpColor(low, high, BREATH_STEPS === 1 ? 1 : step / (BREATH_STEPS - 1)))
  }
  const down = up.slice(1, -1).reverse()
  return [...up, ...down]
})()

/** Breathing color for an arbitrary (possibly negative) phase. */
export function breathColor(phase: number): string {
  const count = BREATH_COLORS.length
  const index = ((Math.floor(phase) % count) + count) % count
  return BREATH_COLORS[index] ?? BREATH_HIGH
}
