/**
 * @file Multiline Ink composer for the TUI (replaces single-line ink-text-input).
 * @description Transparent black input panel pinned to the bottom: no
 * background fill anywhere (the terminal's own black shows through), a thin
 * `╭─╮/│ │/╰─╯` frame that is orange while focused and gray while busy or
 * disabled. Panel height and width derive from the live terminal size
 * (opencode-style responsive): the visible window shrinks on tiny terminals
 * and every resize re-renders via `useTerminalSize`. Enter submits,
 * Shift+Enter inserts a newline (kitty `return+shift`, legacy ConPTY LF),
 * and a leading `/` opens command completion (Up/Down navigate, Tab apply,
 * Esc dismiss, Enter submits). The caret is the REAL terminal block
 * (opencode-style, `useSyncedCaret` + `measureElement`): the OS IME follows
 * the native cursor, so CJK composition lands on the caret instead of the
 * frame bottom. Buffer rules and cursor math live in `composer-state.ts`;
 * this host only renders + routes keys.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box, Text, useInput, type DOMElement } from 'ink'
import {
  applyCompletion,
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
} from './composer-state.js'
import { useTerminalSize } from './terminal-size.js'
import { useSyncedCaret, type CaretDebugSnapshot } from './native-cursor.js'
import { LOGO_TONE } from '../logo.js'

const ACCENT = LOGO_TONE.orange
const MUTED = LOGO_TONE.dim
const BODY = LOGO_TONE.lit

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  disabled: boolean
  busy: boolean
}

export function Composer({ value, onChange, onSubmit, disabled, busy }: ComposerProps): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
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

  const active = !disabled && !busy

  // Clamp synchronously for render (no transient out-of-range frame) and
  // converge state right after, so the visible cursor never jumps.
  const safeCursor = Math.max(0, Math.min(cursor, value.length))

  useEffect(() => {
    if (cursor !== safeCursor) setCursor(safeCursor)
  }, [cursor, safeCursor])

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
    // Forensic dump (see `writeCaretDebug` below): never blocks input.
    // BEL (`\x07`) is Ctrl+G on the wire; accept both parser mappings.
    if ((key.ctrl && input === 'g') || input === '\x07') {
      writeCaretDebug()
      return
    }
    // App owns Ctrl+C / Ctrl+D; other control combos are ignored here.
    if (key.ctrl || key.meta) return

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
        }
        return
      }
    } else if (key.escape) {
      return
    }

    // Lone Enter submits; a \r inside a pasted chunk is content, not submit.
    if (key.return && !key.shift && input.length <= 1) {
      onSubmit(value)
      return
    }
    // Shift+Enter newline (kitty return+shift, or legacy LF from ConPTY).
    if ((key.return && key.shift) || input === '\n') {
      const next = insertText(value, cursor, '\n')
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.tab) {
      const next = insertText(value, cursor, '  ')
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.backspace) {
      const next = deleteBackward(value, cursor)
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.delete) {
      const next = deleteForward(value, cursor)
      onChange(next.value)
      setCursor(next.cursor)
      return
    }
    if (key.leftArrow) {
      move(cursor - 1)
      return
    }
    if (key.rightArrow) {
      move(cursor + 1)
      return
    }
    if (key.home) {
      const { line } = cursorLineOf(value, cursor)
      move(offsetOfLine(value, line, 0))
      return
    }
    if (key.end) {
      const { line } = cursorLineOf(value, cursor)
      const lineText = value.split('\n')[line] ?? ''
      move(offsetOfLine(value, line, lineText.length))
      return
    }
    if (key.upArrow || key.downArrow) {
      const { line, column } = cursorLineOf(value, cursor)
      move(offsetOfLine(value, line + (key.upArrow ? -1 : 1), column))
      return
    }
    // Remaining control keys carry no text.
    if (input.length === 0) return
    // Typing or paste (multiline chunks insert, never submit).
    const next = insertText(value, cursor, input)
    onChange(next.value)
    setCursor(next.cursor)
  }, { isActive: !disabled })

  // Frame geometry from the live terminal size (never frozen, never
  // wrapping): the panel always fits the current width. No background fill
  // — the terminal's own black is the panel background.
  const windowRows = resolveComposerWindow(termRows)
  const totalW = Math.max(10, columns - 2)
  const textW = Math.max(4, totalW - 6) // '│ ' + prompt(2) + text + ' │'
  const itemW = Math.max(4, totalW - 4) // '│ ' + item + ' │'
  const frameColor = active ? ACCENT : 'gray'
  const promptColor = busy ? 'gray' : active ? ACCENT : MUTED

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

  // Position the REAL cursor while focused; hide while busy/disabled (and
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

  const frameRow = (left: string, middle: string, right: string, key: string): React.JSX.Element => (
    <Text key={key} color={frameColor}>{`${left}${middle}${right}`}</Text>
  )

  const contentRow = (body: React.ReactNode, key: string): React.JSX.Element => (
    <Text key={key}>
      <Text color={frameColor}>│ </Text>
      {body}
      <Text color={frameColor}> │</Text>
    </Text>
  )

  const renderTextRow = (line: string, lineIndex: number): React.JSX.Element => {
    const prompt = lineIndex === start ? '› ' : '  '
    if (value === '' && lineIndex === 0) {
      const hint = busy ? 'working…' : 'message (/help)'
      // Single-cursor rule (opencode-style): the REAL cursor is the only
      // caret. While `active` the terminal draws it; while `busy` the
      // discussion's orange `▍` is the activity indicator, so the composer
      // renders plain with NO fake block. A dim block is kept only for the
      // disabled-but-mounted edge (approval gate usually unmounts us).
      if (active || busy) {
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
      return (
        <Text>
          <Text color={promptColor}>{prompt}</Text>
          <Text color={BODY}>{padToWidth(truncateToWidth(line, textW), textW)}</Text>
        </Text>
      )
    }
    // Caret line: single-cursor rule — active renders PLAIN text (native
    // block is the caret); busy renders plain too (the discussion `▍` owns
    // attention); only disabled-but-mounted keeps a dim fake block.
    const sliced = sliceAroundCursor(line, textW, caretExpandedCol)
    if (active || busy) {
      return (
        <Text>
          <Text color={promptColor}>{prompt}</Text>
          <Text color={BODY}>{padToWidth(sliced.text, textW)}</Text>
        </Text>
      )
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

  const renderItemRow = (name: string, hint: string, selected: boolean): React.JSX.Element => {
    const label = `/${name}  ${hint}`
    if (selected) {
      return <Text backgroundColor={ACCENT} color="black">{padToWidth(truncateToWidth(label, itemW), itemW)}</Text>
    }
    return (
      <Text>
        <Text color={ACCENT}>/{name}</Text>
        <Text color={MUTED}>{padToWidth(`  ${hint}`, itemW - name.length - 1)}</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="column" ref={frameRef}>
      {frameRow('╭', '─'.repeat(totalW - 2), '╮', 'top')}
      {rows.map((line, index) => contentRow(renderTextRow(line, start + index), `line-${start + index}`))}
      {showList
        ? candidates.slice(completionStart, completionStart + completionRows).map((item, index) => contentRow(renderItemRow(item.name, item.hint, completionStart + index === highlight), `cmd-${item.name}`))
        : null}
      {frameRow('╰', '─'.repeat(totalW - 2), '╯', 'bottom')}
    </Box>
  )
}
