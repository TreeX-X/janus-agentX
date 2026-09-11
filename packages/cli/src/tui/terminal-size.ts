/**
 * @file Live terminal dimensions for the Ink TUI (no IO besides Ink).
 * @description Thin wrapper over Ink's `useWindowSize` (the opencode
 * `dimensions()` equivalent): subscribes to terminal resize events so every
 * consumer re-renders with fresh columns/rows instead of frozen-at-mount
 * geometry. Unreported dimensions fall back to the 80x24 default, matching
 * Ink's own behavior. Cursor visibility mid-run is owned through Ink's
 * official `useCursor` channel (see `native-cursor.ts`); this module only
 * restores visibility on the way out, TTY-gated so pipes and test doubles
 * are never touched.
 */
import { useWindowSize } from 'ink'
import { CURSOR_SHOW } from './composer-state.js'

export interface TerminalSize {
  columns: number
  rows: number | undefined
}

const FALLBACK_COLUMNS = 80

export const TUI_HORIZONTAL_PADDING = 2

export function useTerminalSize(): TerminalSize {
  const { columns, rows } = useWindowSize()
  return {
    columns: columns && columns > 0 ? columns : FALLBACK_COLUMNS,
    rows: rows && rows > 0 ? rows : undefined,
  }
}

interface CursorCapableStream {
  isTTY?: unknown
  write: (data: string) => unknown
}

/** True only for a live TTY: pipes and test doubles never get cursor codes. */
export function isLiveTerminal(stdout: CursorCapableStream | undefined | null): boolean {
  return !!stdout && (stdout as { isTTY?: boolean }).isTTY === true
}

/** Restore a visible native cursor. No-op unless `stdout` is a live TTY. */
export function restoreNativeCaret(stdout: CursorCapableStream | undefined | null): void {
  if (!isLiveTerminal(stdout)) return
  stdout?.write(CURSOR_SHOW)
}

/* ── Caret shape (opencode-style block) ──────────────────────────────
   JanusX's xterm is configured with a thin `bar` cursor, which reads as a
   tall floating stripe next to CJK text and drifts away from the caret
   visually. opencode instead pins `cursor: { style: "block" }` in `tui.json`.
   The Ink-side equivalent is DECSCUSR: steady block while the TUI owns the
   screen, terminal default (`0 q`) on the way out so every host (JanusX
   xterm, Windows Terminal, ConPTY) gets its own default back. TTY-gated
   like everything else here; a block fills exactly one cell, so shape can
   never be mistaken for a multi-row offset again. */

/** Steady block caret while the TUI owns the screen. */
export const CARET_BLOCK = '\x1b[2 q'
/** Terminal default caret (xterm falls back to its configured style). */
export const CARET_DEFAULT = '\x1b[0 q'

/** Set the caret shape. No-op unless `stdout` is a live TTY. */
export function setCaretShape(stdout: CursorCapableStream | undefined | null, sequence: string): void {
  if (!isLiveTerminal(stdout)) return
  stdout?.write(sequence)
}
