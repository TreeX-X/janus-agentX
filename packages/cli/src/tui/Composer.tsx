/**
 * @file Multiline Ink composer for the TUI (replaces single-line ink-text-input).
 * @description Card-style input panel pinned to the bottom: a
 * `╭─╮/│ │/╰─╯` frame with an accent left edge while focused and neutral
 * edges while disabled, transparent fill (pure black shows through). Command completion
 * floats as a popover above the card (dark highlight, never an orange
 * block). Streaming keeps the editor focused. Panel dimensions follow
 * the live terminal size
 * (opencode-style responsive): the visible window shrinks on tiny terminals
 * and every resize re-renders via `useTerminalSize`. Enter submits,
 * Shift+Enter inserts a newline (kitty `return+shift`, legacy ConPTY LF),
 * and a leading `/` opens command completion (Up/Down navigate, Tab apply,
 * Esc dismiss, Enter submits). At the first/last line, Up/Down recalls
 * submitted-input history shell-style (draft preserved, Down past newest
 * restores it); inner lines still move the cursor. The caret is the REAL terminal block
 * (opencode-style, `useSyncedCaret` + `measureElement`): the OS IME follows
 * the native cursor, so CJK composition lands on the caret instead of the
 * frame bottom. Buffer rules and cursor math live in `composer-state.ts`;
 * this host only renders + routes keys.
 *
 * Keyboard text selection: Shift+arrows/Home/End extends a selection anchor
 * (plain moves collapse it, Esc clears it, edits replace it). Ctrl+A selects
 * all; Ctrl+C copies the selection to the system clipboard (OSC52) plus an
 * in-app buffer and clears it; Ctrl+X cuts; Ctrl+V pastes the in-app buffer
 * (native terminal paste keeps arriving as text, as before). With no
 * selection Ctrl+C falls through to `onInterrupt` (clear/abort/exit), so
 * `App` skips its own Ctrl+C while this composer is active.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box, Text, useInput, useStdout, type DOMElement } from 'ink'
import {
  applyCompletion,
  cursorLineOf,
  deleteBackward,
  deleteForward,
  deleteSelection,
  displayWidth,
  expandTabsWithMap,
  filterCompletions,
  firstToken,
  offsetOfLine,
  padToWidth,
  recallInputHistory,
  replaceSelection,
  resolveComposerWindow,
  rowSelectionSpan,
  type RowSelectionSpan,
  selectedText,
  selectionRange,
  sliceAroundCursor,
  sliceAroundCursorEx,
  splitSelectedText,
  truncateToWidth,
  visibleStart,
} from './composer-state.js'
import { createComposerClipboard } from './clipboard.js'
import { TUI_HORIZONTAL_PADDING, useTerminalSize } from './terminal-size.js'
import { containsMouseSequence } from './scroll.js'
import { useSyncedCaret, type CaretDebugSnapshot } from './native-cursor.js'
import { LOGO_TONE, TUI_CHROME } from '../logo.js'

const ACCENT = LOGO_TONE.orange
const MUTED = LOGO_TONE.dim
const BODY = LOGO_TONE.lit

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  disabled: boolean
  busy: boolean
  /** Submitted inputs for shell-style ↑/↓ recall (oldest-first). */
  history?: readonly string[]
  /** Null browses the draft; otherwise an index into `history`. */
  historyIndex?: number | null
  /** Unsent draft preserved when recall starts. */
  historyDraft?: string
  onHistoryRecall?: (next: { value: string; index: number | null; draft: string }) => void
  /**
   * Ctrl+C with no selection (clear input / abort turn / double-press exit).
   * The composer owns Ctrl+C while active so copy-vs-interrupt never races
   * `App`'s own handler; `App` skips its Ctrl+C exactly when `disabled` is false.
   */
  onInterrupt: () => void
  /** Any copy/cut/paste/select-all gesture (lets `App` drop its exit window). */
  onSelectionAction?: () => void
}

// Note: keyboard selection + clipboard copy/cut/paste live in this composer — see .agents/notes/implemented/feature/2026-09-11-composer-select-copy-paste.md
export function Composer({ value, onChange, onSubmit, disabled, busy, history = [], historyIndex = null, historyDraft = '', onHistoryRecall, onInterrupt, onSelectionAction }: ComposerProps): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  // Live terminal size: every resize re-renders with fresh geometry instead
  // of the frozen-at-mount dimensions (opencode `dimensions()` equivalent).
  const { columns, rows: termRows } = useTerminalSize()
  // Anchor for the REAL cursor: measured post-layout via `measureElement`
  // (see `native-cursor.ts`). Never computed manually — the discussion
  // `flexGrow` above moves this box without changing our props.
  const frameRef = useRef<DOMElement | null>(null)
  // Forensic tap for cursor-deviation reports: overwritten every render by
  // `useSyncedCaret`, dumped to a log file on Ctrl+G (see `useInput` below).
  const caretDebugRef = useRef<CaretDebugSnapshot | null>(null)

  const active = !disabled

  // Clamp synchronously for render (no transient out-of-range frame) and
  // converge state right after, so the visible cursor never jumps.
  const safeCursor = Math.max(0, Math.min(cursor, value.length))

  useEffect(() => {
    if (cursor !== safeCursor) setCursor(safeCursor)
  }, [cursor, safeCursor])

  // Active selection (render + clipboard only; stale anchors clamp, wipes clear).
  const selection = active ? selectionRange(value, anchor, safeCursor) : null
  const clearSelection = (): void => setAnchor(null)

  useEffect(() => {
    if (disabled && anchor !== null) {
      setAnchor(null)
      return
    }
    if (anchor !== null && (value === '' || anchor < 0 || anchor > value.length)) {
      setAnchor(value === '' ? null : Math.max(0, Math.min(anchor, value.length)))
    }
  }, [anchor, disabled, value])

  const { stdout } = useStdout()
  const clipboard = useMemo(() => createComposerClipboard(stdout), [stdout])

  /** Copy the selection out (system clipboard + in-app buffer), then drop it. */
  const copySelection = (): boolean => {
    if (!selection) return false
    const text = selectedText(value, anchor, safeCursor)
    if (text) clipboard.copy(text)
    setAnchor(null)
    onSelectionAction?.()
    return true
  }

  const candidates = useMemo(() => filterCompletions(value, safeCursor), [value, safeCursor])
  const token = firstToken(value)
  const showList = !disabled && !busy && candidates.length > 0 && dismissedFor !== token

  useEffect(() => {
    setHighlight(0)
  }, [token])

  const move = (next: number): void => {
    setCursor(Math.max(0, Math.min(next, value.length)))
  }

  useInput((input, key) => {
    // SGR mouse reporting (enabled by `App` for wheel scrolling) arrives as
    // escape text that Ink 7 cannot parse — swallow it so wheel/click bytes
    // never land in the buffer. `App` consumes the wheel part for scrolling.
    if (containsMouseSequence(input)) return
    // Forensic dump (see `writeCaretDebug` below): never blocks input.
    // BEL (`\x07`) is Ctrl+G on the wire; accept both parser mappings.
    if ((key.ctrl && input === 'g') || input === '\x07') {
      writeCaretDebug()
      return
    }
    // App owns Ctrl+D; other control combos are ignored here.
    // Exception: clipboard keys while active — Ctrl+C copies a selection and
    // only falls through to `onInterrupt` (clear/abort/exit) with none, so
    // copy-vs-interrupt is decided in this one handler, never raced with App.
    if (key.ctrl && !key.meta && (input === 'a' || input === 'c' || input === 'x' || input === 'v')) {
      if (input === 'a') {
        if (value.length > 0) {
          setAnchor(0)
          setCursor(value.length)
          onSelectionAction?.()
        }
        return
      }
      if (input === 'c') {
        if (copySelection()) return
        onInterrupt()
        return
      }
      if (input === 'x') {
        if (selection) {
          copySelection()
          const next = deleteSelection(value, anchor, cursor)
          onChange(next.value)
          setCursor(next.cursor)
        }
        return
      }
      const pasted = clipboard.paste()
      if (pasted) {
        const next = replaceSelection(value, anchor, cursor, pasted)
        onChange(next.value)
        setCursor(next.cursor)
        clearSelection()
        onSelectionAction?.()
      }
      return
    }
    if (key.ctrl || key.meta) return

    // Keyboard selection: Shift+arrows/Home/End extends from the anchor
    // (starting it at the cursor). Edge lines extend to the buffer ends
    // instead of recalling history — an explicit shift means "select".
    if (key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end)) {
      const from = anchor ?? cursor
      let next = cursor
      if (key.leftArrow) next = cursor - 1
      else if (key.rightArrow) next = cursor + 1
      else if (key.home) {
        const { line } = cursorLineOf(value, cursor)
        next = offsetOfLine(value, line, 0)
      } else if (key.end) {
        const { line } = cursorLineOf(value, cursor)
        const lineText = value.split('\n')[line] ?? ''
        next = offsetOfLine(value, line, lineText.length)
      } else if (key.upArrow || key.downArrow) {
        const { line, column } = cursorLineOf(value, cursor)
        const totalLines = value.split('\n').length
        if (key.upArrow && line > 0) next = offsetOfLine(value, line - 1, column)
        else if (key.downArrow && line < totalLines - 1) next = offsetOfLine(value, line + 1, column)
        else next = key.upArrow ? 0 : value.length
      }
      setAnchor(Math.max(0, Math.min(from, value.length)))
      move(next)
      return
    }

    if (showList) {
      if (key.upArrow) {
        setHighlight((current) => (current - 1 + candidates.length) % candidates.length)
        return
      }
      if (key.downArrow) {
        setHighlight((current) => (current + 1) % candidates.length)
        return
      }
      if (key.escape) {
        setDismissedFor(token)
        return
      }
      if (key.tab) {
        const picked = candidates[highlight] ?? candidates[0]
        if (picked) {
          const applied = applyCompletion(value, picked)
          onChange(applied.value)
          setCursor(applied.cursor)
          clearSelection()
        }
        return
      }
    } else if (key.escape) {
      if (selection) clearSelection()
      return
    }

    // Lone Enter submits; a \r inside a pasted chunk is content, not submit.
    if (key.return && !key.shift && input.length <= 1) {
      onSubmit(value)
      return
    }
    // Shift+Enter newline (kitty return+shift, or legacy LF from ConPTY).
    if ((key.return && key.shift) || input === '\n') {
      const next = replaceSelection(value, anchor, cursor, '\n')
      onChange(next.value)
      setCursor(next.cursor)
      clearSelection()
      return
    }
    if (key.tab) {
      const next = replaceSelection(value, anchor, cursor, '  ')
      onChange(next.value)
      setCursor(next.cursor)
      clearSelection()
      return
    }
    if (key.backspace) {
      if (selection) {
        const next = deleteSelection(value, anchor, cursor)
        onChange(next.value)
        setCursor(next.cursor)
        clearSelection()
        return
      }
      const next = deleteBackward(value, cursor)
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.delete) {
      if (selection) {
        const next = deleteSelection(value, anchor, cursor)
        onChange(next.value)
        setCursor(next.cursor)
        clearSelection()
        return
      }
      const next = deleteForward(value, cursor)
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.leftArrow) {
      if (selection) {
        setCursor(selection.start)
        clearSelection()
        return
      }
      move(cursor - 1)
      return
    }
    if (key.rightArrow) {
      if (selection) {
        setCursor(selection.end)
        clearSelection()
        return
      }
      move(cursor + 1)
      return
    }
    if (key.home) {
      clearSelection()
      const { line } = cursorLineOf(value, cursor)
      move(offsetOfLine(value, line, 0))
      return
    }
    if (key.end) {
      clearSelection()
      const { line } = cursorLineOf(value, cursor)
      const lineText = value.split('\n')[line] ?? ''
      move(offsetOfLine(value, line, lineText.length))
      return
    }
    if (key.upArrow || key.downArrow) {
      clearSelection()
      const { line, column } = cursorLineOf(value, cursor)
      const totalLines = value.split('\n').length
      if (key.upArrow && line > 0) {
        move(offsetOfLine(value, line - 1, column))
        return
      }
      if (key.downArrow && line < totalLines - 1) {
        move(offsetOfLine(value, line + 1, column))
        return
      }
      // Edge line: shell-style history recall (draft preserved, Down past
      // newest restores it). Completion list above takes precedence.
      const next = recallInputHistory(
        history,
        { index: historyIndex, draft: historyDraft },
        value,
        key.upArrow ? 'up' : 'down',
      )
      if (next.value !== value || next.index !== historyIndex) {
        onHistoryRecall?.(next)
        if (!onHistoryRecall) onChange(next.value)
        setCursor(next.value.length)
      }
      return
    }
    // Remaining control keys carry no text.
    if (input.length === 0) return
    // Typing or paste (multiline chunks insert, never submit): a selection
    // is replaced instead of kept alongside the new text.
    const next = replaceSelection(value, anchor, cursor, input)
    onChange(next.value)
    setCursor(next.cursor)
    clearSelection()
  }, { isActive: !disabled })

  // Frame geometry from the live terminal size (never frozen, never
  // wrapping): the panel always fits the current width. Accent left edge
  // while focused, neutral edges elsewhere, transparent fill so the
  // terminal stays pure black; geometry is unchanged.
  const windowRows = resolveComposerWindow(termRows)
  const totalW = Math.max(10, columns - TUI_HORIZONTAL_PADDING * 2)
  const textW = Math.max(4, totalW - 6) // '│ ' + prompt(2) + text + ' │'
  const itemW = Math.max(4, totalW - 4) // '│ ' + item + ' │'
  const frameIdle = TUI_CHROME.cardBorder
  const promptColor = active ? ACCENT : MUTED

  const rawLines = value.split('\n')
  const position = cursorLineOf(value, safeCursor)
  const start = visibleStart(rawLines.length, position.line, windowRows.maxRows)
  const rows = rawLines.slice(start, start + windowRows.maxRows).map((line) => line.replace(/\t/g, '  '))
  while (rows.length < windowRows.minRows) rows.push('')

  // Leave room for the header, footer, margins, frame and Ink's newline.
  // Scroll the completion window with selection instead of growing the frame.
  const completionRows = Math.max(1, (termRows ?? 24) - rows.length - 10)
  const completionStart = visibleStart(candidates.length, highlight, completionRows)

  // Real-cursor offsets (opencode-style): the terminal draws the block, the
  // OS IME follows it. `dx` is CJK-aware via `displayWidth` (`string-width`,
  // the same ruler Ink's layout uses — never a hand-rolled table); tabs are expanded before measuring so the
  // column matches what is painted. `dy` is the visible row inside the
  // frame (top border + scrolled caret row). The absolute origin comes from
  // `measureElement(frameRef)` inside `useSyncedCaret` — never hard-coded,
  // because the `flexGrow` discussion above moves us every turn.
  const caretRawLine = rawLines[position.line] ?? ''
  const caretBeforeRaw = caretRawLine.slice(0, position.column).replace(/\t/g, '  ')
  const caretExpandedCol = [...caretBeforeRaw].length
  const caretExpandedLine = caretRawLine.replace(/\t/g, '  ')
  const caretSliced = value === '' && position.line === 0
    ? { text: '', cursor: 0 }
    : sliceAroundCursor(caretExpandedLine, textW, caretExpandedCol)
  const caretBeforeWidth = displayWidth([...caretSliced.text].slice(0, caretSliced.cursor).join(''))
  const caretDx = 4 + caretBeforeWidth // '│ ' (2) + prompt '› '/'  ' (2)
  const caretDy = 1 + Math.max(0, position.line - start) // top border + row

  // Position the REAL cursor while focused; hide while disabled (and
  // on the first frame before measurement). No painted breathing block
  // while active — the terminal's own block IS the caret, so IME and sight
  // can never desync. No timers: native blink needs zero re-renders.
  useSyncedCaret({ active, anchorRef: frameRef, dx: caretDx, dy: caretDy, debugRef: caretDebugRef })

  // Forensic dump for "cursor vs text misaligned" reports: press Ctrl+G and
  // a one-line JSON snapshot lands in %TEMP%/janus-cursor-debug.log
  // (override with JANUS_CURSOR_DEBUG_FILE). Proves which build is running
  // and shows the exact intent vs buffer state — no more guessing offsets.
  const writeCaretDebug = (): void => {
    try {
      const snapshot = {
        at: new Date().toISOString(),
        value,
        cursor,
        safeCursor,
        line: position.line,
        column: position.column,
        start,
        columns,
        termRows: termRows ?? null,
        active,
        busy,
        disabled,
        caretDx,
        caretDy,
        caret: caretDebugRef.current,
      }
      const file = process.env['JANUS_CURSOR_DEBUG_FILE'] ?? join(tmpdir(), 'janus-cursor-debug.log')
      appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
    } catch {
      // Best effort: diagnostics must never break input.
    }
  }

  const edgeColor = active ? ACCENT : MUTED

  const frameRow = (left: string, middle: string, right: string, key: string): React.JSX.Element => (
    <Text key={key}>
      <Text color={edgeColor}>{left}</Text>
      <Text color={frameIdle}>{middle}</Text>
      <Text color={frameIdle}>{right}</Text>
    </Text>
  )

  const contentRow = (body: React.ReactNode, key: string): React.JSX.Element => (
    <Text key={key}>
      <Text color={edgeColor}>│ </Text>
      {body}
      <Text color={frameIdle}> │</Text>
    </Text>
  )

  const renderTextRow = (line: string, lineIndex: number): React.JSX.Element => {
    const prompt = lineIndex === start ? '› ' : '  '
    // Selected char span inside a painted row: window markers (`…`) and
    // padding never highlight, only buffer-backed content does.
    const spanForRow = (
      displayed: string,
      sliceStart: number,
      leading: boolean,
      trailing: boolean,
    ): RowSelectionSpan | null => {
      if (!selection) return null
      const rawLine = rawLines[lineIndex]
      if (rawLine === undefined) return null
      const contentLength = [...displayed].length - (leading ? 1 : 0) - (trailing ? 1 : 0)
      return rowSelectionSpan({
        expandedOffsets: expandTabsWithMap(rawLine).offsets,
        lineStartOffset: offsetOfLine(value, lineIndex, 0),
        selection,
        sliceStart,
        contentLength,
        leadingEllipsis: leading,
      })
    }
    const paintedRow = (displayed: string, span: RowSelectionSpan | null): React.JSX.Element => {
      const [before, selected, after] = splitSelectedText(displayed, span)
      const rest = Math.max(0, textW - displayWidth(displayed))
      if (!selected) {
        return (
          <Text>
            <Text color={promptColor}>{prompt}</Text>
            <Text color={BODY}>{displayed}{' '.repeat(rest)}</Text>
          </Text>
        )
      }
      return (
        <Text>
          <Text color={promptColor}>{prompt}</Text>
          <Text color={BODY}>{before}</Text>
          <Text backgroundColor={TUI_CHROME.selectBg} color={BODY}>{selected}</Text>
          <Text color={BODY}>{after}{' '.repeat(rest)}</Text>
        </Text>
      )
    }
    if (value === '' && lineIndex === 0) {
      const hint = busy ? 'message' : 'message (/help)'
      // The native caret stays visible during turns; disabled overlays own focus.
      if (active) {
        // Real cursor sits on the first hint cell; render plain and let the
        // terminal draw the block (opencode-style, IME follows it).
        return (
          <Text>
            <Text color={promptColor}>{prompt}</Text>
            <Text color={MUTED}>{padToWidth(hint, textW)}</Text>
          </Text>
        )
      }
      return (
        <Text>
          <Text color={promptColor}>{prompt}</Text>
          <Text backgroundColor={MUTED} color="black"> </Text>
          <Text color={MUTED}>{padToWidth(hint, textW - 1)}</Text>
        </Text>
      )
    }
    if (lineIndex !== position.line) {
      const truncated = truncateToWidth(line, textW)
      const trailing = displayWidth(line) > textW
      return paintedRow(truncated, spanForRow(truncated, 0, false, trailing))
    }
    // Only a disabled, idle composer paints a dim placeholder caret.
    const sliced = sliceAroundCursorEx(line, textW, caretExpandedCol)
    if (active || busy) {
      return paintedRow(sliced.text, spanForRow(sliced.text, sliced.start, sliced.leadingEllipsis, sliced.trailingEllipsis))
    }
    const chars = [...sliced.text]
    const before = chars.slice(0, sliced.cursor).join('')
    const at = chars[sliced.cursor] ?? ' '
    const after = chars.slice(sliced.cursor + 1).join('')
    const rest = Math.max(0, textW - displayWidth(sliced.text))
    return (
      <Text>
        <Text color={promptColor}>{prompt}</Text>
        <Text color={BODY}>
          {before}
          <Text backgroundColor={MUTED} color="black">{at}</Text>
          {after}
          {' '.repeat(rest)}
        </Text>
      </Text>
    )
  }

  const renderItemRow = (name: string, hint: string, selected: boolean, key: string): React.JSX.Element => {
    const label = `/${name}  ${hint}`
    // Borderless popover rows above the card: same row budget as the old
    // in-frame list (no extra chrome rows on small terminals); selection is
    // a dark highlight, everything else stays transparent on pure black.
    if (selected) {
      return <Text key={key} backgroundColor={TUI_CHROME.selectBg} color={BODY}>{padToWidth(truncateToWidth(label, itemW), itemW)}</Text>
    }
    return (
      <Text key={key}>
        <Text color={ACCENT}>/{name}</Text>
        <Text color={MUTED}>{padToWidth(`  ${hint}`, itemW - name.length - 1)}</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      {showList
        ? candidates.slice(completionStart, completionStart + completionRows).map((item, index) => renderItemRow(item.name, item.hint, completionStart + index === highlight, `cmd-${item.name}`))
        : null}
      <Box flexDirection="column" ref={frameRef}>
        {frameRow('╭', '─'.repeat(totalW - 2), '╮', 'top')}
        {rows.map((line, index) => contentRow(renderTextRow(line, start + index), `line-${start + index}`))}
        {frameRow('╰', '─'.repeat(totalW - 2), '╯', 'bottom')}
      </Box>
    </Box>
  )
}
