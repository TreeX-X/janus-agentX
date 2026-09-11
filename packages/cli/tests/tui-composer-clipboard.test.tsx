/**
 * Composer keyboard selection + clipboard flows, asserted by behavior (the
 * test stdout has no color support, so highlight paint is covered by the
 * pure `rowSelectionSpan`/`splitSelectedText` units instead).
 *
 * - Shift+Left extends the selection (cut/typing act on the exact range).
 * - Ctrl+A/Ctrl+C copies, Ctrl+X cuts, Ctrl+V pastes the in-app buffer.
 * - Esc and plain arrows collapse the selection before acting.
 * - Bare Ctrl+C delegates to `onInterrupt` without touching the text.
 */
import React, { useState } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Composer, type ComposerMouseControl } from '../src/tui/Composer.js'
import type { ComposerFrameRect, TerminalOffset } from '../src/tui/composer-state.js'

async function waitForFrame(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const SHIFT_LEFT = '\x1b[1;2D'
const LEFT = '\x1b[D'
const CTRL_A = '\x01'
const CTRL_C = '\x03'
const CTRL_V = '\x16'
const CTRL_X = '\x18'
const ESC = '\x1b'

const tick = async (ms = 60): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface Harness {
  latest: () => string
  interrupts: () => number
  selections: () => number
  stdin: { write: (data: string) => void }
  lastFrame: () => string | undefined
  unmount: () => void
  frameRectRef: { current: ComposerFrameRect | null }
  terminalOffsetRef: { current: TerminalOffset | null }
  mouseControlRef: { current: ComposerMouseControl | null }
}

function mountComposer(): Harness {
  let current = ''
  let interruptCount = 0
  let selectionCount = 0
  const frameRectRef: Harness['frameRectRef'] = { current: null }
  const terminalOffsetRef: Harness['terminalOffsetRef'] = { current: null }
  const mouseControlRef: Harness['mouseControlRef'] = { current: null }
  function Wrapper(): React.JSX.Element {
    const [value, setValue] = useState('')
    return (
      <Composer
        value={value}
        onChange={(next) => {
          current = next
          setValue(next)
        }}
        onSubmit={() => {}}
        onInterrupt={() => {
          interruptCount += 1
        }}
        onSelectionAction={() => {
          selectionCount += 1
        }}
        frameRectRef={frameRectRef}
        terminalOffsetRef={terminalOffsetRef}
        mouseControlRef={mouseControlRef}
        disabled={false}
        busy={false}
      />
    )
  }
  const app = render(<Wrapper />)
  return {
    latest: () => current,
    interrupts: () => interruptCount,
    selections: () => selectionCount,
    stdin: app.stdin,
    lastFrame: app.lastFrame,
    unmount: app.unmount,
    frameRectRef,
    terminalOffsetRef,
    mouseControlRef,
  }
}

async function typeHello(composer: Harness): Promise<void> {
  composer.stdin.write('hello')
  await waitForFrame(() => (composer.lastFrame() ?? '').includes('hello'))
}

/** Drive a mouse drag through `mouseControl` and wait for the commit.
 *
 * Direct calls bypass Ink's discrete-update flush, so the commit they
 * schedule lands on React's own (racy) timetable — unlike production, where
 * every stdin chunk flushes synchronously. The control handle is recreated
 * on every commit, so its identity flip proves the drag state landed.
 */
async function drag(
  composer: Harness,
  pressCell: [number, number],
  moveCell: [number, number],
  releaseCell: [number, number],
): Promise<{ press: boolean; move: boolean; release: boolean }> {
  const before = composer.mouseControlRef.current
  const control = before!
  const press = control.press(...pressCell)
  const move = control.move(...moveCell)
  const release = control.release(...releaseCell)
  await waitForFrame(() => composer.mouseControlRef.current !== null && composer.mouseControlRef.current !== before)
  return { press, move, release }
}

/** One keypress per stdin chunk (rapid writes would coalesce into one). */
async function press(composer: Harness, data: string): Promise<void> {
  composer.stdin.write(data)
  await tick()
}

describe('Composer selection + clipboard', () => {
  it('cuts the Shift-selected tail and pastes it back', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      await press(composer, SHIFT_LEFT)
      await press(composer, SHIFT_LEFT)
      // Selection [3,5) = 'lo': cut leaves 'hel', paste restores 'hello'.
      await press(composer, CTRL_X)
      await waitForFrame(() => composer.latest() === 'hel')
      expect(composer.selections()).toBeGreaterThan(0)
      await press(composer, CTRL_V)
      await waitForFrame(() => composer.latest() === 'hello')
    } finally {
      composer.unmount()
    }
  })

  it('copies with Ctrl+A/Ctrl+C and pastes with Ctrl+V', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      await press(composer, CTRL_A)
      await press(composer, CTRL_C)
      // Copy keeps the text and never interrupts.
      await waitForFrame(() => composer.selections() > 0)
      expect(composer.latest()).toBe('hello')
      expect(composer.interrupts()).toBe(0)
      // Replace-all with new text, then paste the copied word after it.
      await press(composer, CTRL_A)
      await press(composer, 'X')
      await waitForFrame(() => composer.latest() === 'X')
      await press(composer, CTRL_V)
      await waitForFrame(() => composer.latest() === 'Xhello')
    } finally {
      composer.unmount()
    }
  })

  it('replaces the Shift-selection on typing', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      await press(composer, SHIFT_LEFT)
      await press(composer, 'X')
      // Selection [4,5) = 'o' replaced: 'hellX', not 'helloX'.
      await waitForFrame(() => composer.latest() === 'hellX')
    } finally {
      composer.unmount()
    }
  })

  it('clears the selection on Esc', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      await press(composer, CTRL_A)
      await press(composer, ESC)
      await press(composer, 'X')
      // Cleared selection inserts at the end; a live one would replace all.
      await waitForFrame(() => composer.latest() === 'helloX')
    } finally {
      composer.unmount()
    }
  })

  it('collapses the selection on a plain arrow before moving', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      await press(composer, CTRL_A)
      // Plain Left collapses to the selection start; typing then prepends.
      await press(composer, LEFT)
      await press(composer, 'X')
      await waitForFrame(() => composer.latest() === 'Xhello')
    } finally {
      composer.unmount()
    }
  })

  it('delegates bare Ctrl+C to onInterrupt without touching the text', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      composer.stdin.write(CTRL_C)
      await waitForFrame(() => composer.interrupts() === 1)
      expect(composer.latest()).toBe('hello')
    } finally {
      composer.unmount()
    }
  })

  it('constrains mouse drags to content and auto-copies on release', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      // Zero offset pretends terminal cells equal Ink cells.
      composer.terminalOffsetRef.current = { dx: 0, dy: 0 }
      await waitForFrame(() => composer.frameRectRef.current !== null && composer.mouseControlRef.current !== null)
      const rect = composer.frameRectRef.current!
      // 1-based terminal cells over 'e' (char 1) and the second 'l' (char 3).
      const row = rect.y + 1 + 1
      const colAt = (charIdx: number): number => rect.x + 4 + charIdx + 1
      const result = await drag(composer, [colAt(1), row], [colAt(3), row], [colAt(3), row])
      expect(result).toEqual({ press: true, move: true, release: true })
      // Drag resolved [1,3) = 'el': Backspace deletes exactly it, no chrome.
      await press(composer, '\x7f')
      await waitForFrame(() => composer.latest() === 'hlo')
    } finally {
      composer.unmount()
    }
  })

  it('keeps the mouse selection for keyboard copy after release', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      composer.terminalOffsetRef.current = { dx: 0, dy: 0 }
      await waitForFrame(() => composer.frameRectRef.current !== null && composer.mouseControlRef.current !== null)
      const rect = composer.frameRectRef.current!
      const row = rect.y + 1 + 1
      const colAt = (charIdx: number): number => rect.x + 4 + charIdx + 1
      await drag(composer, [colAt(1), row], [colAt(3), row], [colAt(3), row])
      // Release auto-copied 'el' and kept the highlight: keyboard copy takes
      // the same range, then paste proves the clipboard content.
      await press(composer, CTRL_C)
      await waitForFrame(() => composer.selections() > 0)
      expect(composer.latest()).toBe('hello')
      await press(composer, CTRL_A)
      await press(composer, 'X')
      await waitForFrame(() => composer.latest() === 'X')
      await press(composer, CTRL_V)
      await waitForFrame(() => composer.latest() === 'Xel')
    } finally {
      composer.unmount()
    }
  })

  it('clamps frame-side presses to content edges and ignores borders', async () => {
    const composer = mountComposer()
    try {
      await typeHello(composer)
      composer.terminalOffsetRef.current = { dx: 0, dy: 0 }
      await waitForFrame(() => composer.frameRectRef.current !== null && composer.mouseControlRef.current !== null)
      const rect = composer.frameRectRef.current!
      const row = rect.y + 1 + 1
      const control = composer.mouseControlRef.current!
      // Top border is not content.
      expect(control.press(rect.x + 4 + 1, rect.y + 1)).toBe(false)
      // Prompt side clamps to the line start: typing then prepends.
      const result = await drag(composer, [rect.x + 1, row], [rect.x + 1, row], [rect.x + 1, row])
      expect(result.press).toBe(true)
      await press(composer, 'X')
      await waitForFrame(() => composer.latest() === 'Xhello')
    } finally {
      composer.unmount()
    }
  })
})
