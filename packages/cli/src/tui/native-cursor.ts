/**
 * @file Real (native) caret positioning for the Ink TUI — IME anchor.
 * @description Why this exists (root cause of the IME bug):
 * - The previous `useOwnedCaret()` hid the native cursor
 *   (`setCursorPosition(undefined)`) and painted a breathing fake block.
 *   Ink then leaves the real cursor at the end of the frame (bottom line),
 *   so Windows Terminal / ConPTY anchors the IME candidate window there —
 *   "bottom-right", never following the rendered caret. This exactly matches
 *   the `korean-terminal` test1 (fake `chalk.inverse`) broken case.
 * - opencode (OpenTUI `TextareaRenderable`, `cursor: {style:"block"}` in
 *   `tui.json`) does the opposite: the renderer moves the REAL terminal
 *   cursor onto the caret cell every frame. The OS IME follows the real
 *   cursor, so composition always appears at the caret.
 * - Ink's official fix is the same: `useCursor()` with a real `{x,y}`
 *   (see `examples/cursor-ime`, docs "essential for IME support", and
 *   `use-cursor.js`: "Pass undefined to hide"). Combined with a CJK-aware
 *   width (`displayWidth` = `string-width`, the same ruler Ink lays out
 *   with) the IME lands on the caret even for wide runes.
 * - Coordinates are Ink-output-relative (0,0 = first line). Because `App`
 *   pins the composer to the bottom with a dynamic `flexGrow` discussion
 *   above, manual top-down `y` math is fragile (see Ink issue #870). So the
 *   anchor `Box` is measured with Ink's official `measureElement()` (walks
 *   ancestors to an absolute position) in a post-commit effect, then the
 *   intra-line offsets (`dx`/`dy`, `dx` via `string-width`) are added during render. One frame of lag on layout
 *   shifts beats a permanently parked IME.
 * - App reserves the final terminal row for Ink's trailing newline, so
 *   layout and terminal coordinates agree for both paints and cursor-only
 *   updates. No platform-dependent offset is added to the measured origin.
 */
import { useEffect, useState } from 'react'
import { measureElement, useCursor, type DOMElement } from 'ink'
import type { RefObject } from 'react'

export interface CaretDebugSnapshot {
  origin: { x: number; y: number } | null
  dx: number
  dy: number
  active: boolean
  /** The exact intent forwarded to Ink this render (`undefined` = hidden). */
  intent: { x: number; y: number } | undefined
}

export interface SyncedCaretOptions {
  /** False while busy/disabled/approval-gate: hide the native cursor. */
  active: boolean
  /** Ref of the composer's root `Box` (origin for `measureElement`). */
  anchorRef: RefObject<DOMElement | null>
  /** Cell offset inside the anchor box: frame (`│ `) + prompt + before-cursor. */
  dx: number
  /** Row offset inside the anchor box: top border + (cursorLine - start). */
  dy: number
  /** Optional forensic tap: overwritten every render, never triggers renders. */
  debugRef?: RefObject<CaretDebugSnapshot | null>
}

/**
 * Position the REAL terminal cursor on the caret cell while `active`;
 * hide it otherwise. Callers render plain text and let the terminal draw
 * the block (opencode-style) — no painted fake block while active, so the
 * IME anchor and the visible caret can never desync.
 */
export function useSyncedCaret({ active, anchorRef, dx, dy, debugRef }: SyncedCaretOptions): void {
  const { setCursorPosition } = useCursor()
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)

  // Re-measure after EVERY commit (no dep array): sibling pushes (new
  // messages/streaming), the `/` popup, and resizes all move the composer
  // without changing its own props. `measureElement` is post-layout only
  // (returns 0,0 during render), hence the effect + state round-trip.
  useEffect(() => {
    const node = anchorRef.current
    if (!node) return
    try {
      const measured = measureElement(node)
      setOrigin((prev) =>
        prev !== null && prev.x === measured.x && prev.y === measured.y ? prev : { x: measured.x, y: measured.y },
      )
    } catch {
      // Best effort: a missed frame keeps the previous origin.
    }
  })

  if (!active || origin === null) {
    // First frame before measurement, plus all inactive states: hide.
    // Ink applies this atomically with the paint (cursor-only fast path).
    if (debugRef) debugRef.current = { origin, dx, dy, active, intent: undefined }
    setCursorPosition(undefined)
    return
  }
  if (debugRef) debugRef.current = { origin, dx, dy, active, intent: { x: origin.x + dx, y: origin.y + dy } }
  setCursorPosition({ x: origin.x + dx, y: origin.y + dy })
}

/**
 * @deprecated Use `useSyncedCaret` — hiding the native cursor parks the IME
 * at the frame bottom. Kept for tests referencing the old symbol.
 */
export function useOwnedCaret(): void {
  const { setCursorPosition } = useCursor()
  setCursorPosition(undefined)
}
