/**
 * @file Overlay UI primitives for the Ink TUI: command palette + line input.
 * @description Modal boxes rendered above the composer. Each owns its own
 * `useInput` (mounted = active), so the App shell only needs to disable the
 * composer and ignore global keys while an overlay is open.
 */
import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { LOGO_TONE, TUI_CHROME } from '../logo.js'
import { EFFORT_META, type EffortLevel } from '../effort.js'
import { padToWidth, truncateToWidth } from './composer-state.js'

export const ACCENT = LOGO_TONE.orange
export const MUTED = LOGO_TONE.dim
export const BODY = LOGO_TONE.lit

export function PanelFrame({ title, hint, children }: {
  title: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  // Card-style panel (design/janus-TUI-design.html): neutral single border
  // with an accent left edge, transparent fill so the terminal stays pure
  // black. Titles keep their `◇` prefix where callers pass one
  // (palette/connect/mode switchers); the approval gate and question panel
  // pass accent-free titles.
  return (
    <Box
      borderStyle="single"
      borderColor={TUI_CHROME.cardBorder}
      borderLeftColor={ACCENT}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={ACCENT} bold>{title}</Text>
      {children}
      <Text color={MUTED}>{hint}</Text>
    </Box>
  )
}

/** Selected-row highlight: dark raised background, no orange block. */
export function SelectedRow({ text, width }: { text: string; width: number }): React.JSX.Element {
  return <Text backgroundColor={TUI_CHROME.selectBg} color={BODY}>{padToWidth(truncateToWidth(text, width), width)}</Text>
}

export interface PaletteItem {
  id: string
  label: string
  hint?: string
}

/** Filter-as-you-type command list (opencode ctrl+p equivalent). */
export function CommandPalette({ items, onPick, onClose }: {
  items: PaletteItem[]
  onPick: (item: PaletteItem) => void
  onClose: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const rows = needle
      ? items.filter((item) => `${item.label} ${item.hint ?? ''} ${item.id}`.toLowerCase().includes(needle))
      : items
    return rows
  }, [items, filter])
  const selected = Math.min(index, Math.max(0, visible.length - 1))

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow) {
      setIndex((current) => (current - 1 + visible.length) % Math.max(1, visible.length))
      return
    }
    if (key.downArrow) {
      setIndex((current) => (current + 1) % Math.max(1, visible.length))
      return
    }
    if (key.return) {
      const picked = visible[selected]
      if (picked) onPick(picked)
      return
    }
    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1))
      setIndex(0)
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    if (!input || input.includes('\n') || input.includes('\r')) return
    setFilter((current) => current + input)
    setIndex(0)
  }, { isActive: true })

  return (
    <PanelFrame title="◇ command palette" hint="↑↓ move · Enter run · Esc close">
      <Text>
        <Text color={MUTED}>› </Text>
        <Text color={BODY}>{filter}</Text>
        <Text backgroundColor={MUTED} color="black"> </Text>
      </Text>
      {visible.length === 0 ? <Text color={MUTED}>(no match)</Text> : null}
      {visible.map((item, row) => {
        const label = `${item.label}${item.hint ? `  ${item.hint}` : ''}`
        if (row === selected) {
          return <SelectedRow key={item.id} text={label} width={60} />
        }
        return (
          <Text key={item.id}>
            <Text color={BODY}>{truncateToWidth(item.label, 60)}</Text>
            {item.hint ? <Text color={MUTED}>{`  ${item.hint}`}</Text> : null}
          </Text>
        )
      })}
    </PanelFrame>
  )
}

/** Two-option switch panel (approval mode): arrows + Enter, Esc closes. */
export function ApprovalPanel({ current, onPick, onClose }: {
  current: 'auto-run' | 'per-action'
  onPick: (mode: 'auto-run' | 'per-action') => void
  onClose: () => void
}): React.JSX.Element {
  const modes = useMemo<Array<{ id: 'auto-run' | 'per-action'; hint: string }>>(() => [
    { id: 'auto-run', hint: 'tools run immediately' },
    { id: 'per-action', hint: 'each write asks y/N' },
  ], [])
  const [index, setIndex] = useState(() => Math.max(0, modes.findIndex((mode) => mode.id === current)))

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      setIndex((prev) => (prev + (key.upArrow ? -1 : 1) + modes.length) % modes.length)
      return
    }
    if (key.return) {
      const picked = modes[index]
      if (picked) onPick(picked.id)
    }
  }, { isActive: true })

  return (
    <PanelFrame title="◇ approval mode" hint="↑↓ move · Enter switch · Esc close">
      {modes.map((mode, row) => {
        const label = `${mode.id === current ? '*' : ' '} ${mode.id}  ${mode.hint}`
        return row === index
          ? <SelectedRow key={mode.id} text={label} width={60} />
          : <Text key={mode.id} color={BODY}>{label}</Text>
      })}
    </PanelFrame>
  )
}

/** Interactive reasoning-effort switcher (bare /effort): arrows + Enter, Esc closes. */
export function EffortPanel({ current, onPick, onClose }: {
  current: string
  onPick: (level: EffortLevel) => void
  onClose: () => void
}): React.JSX.Element {
  const levels = useMemo(() => [...EFFORT_META], [])
  const [index, setIndex] = useState(() => Math.max(0, levels.findIndex((meta) => meta.id === current)))

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      setIndex((prev) => (prev + (key.upArrow ? -1 : 1) + levels.length) % levels.length)
      return
    }
    if (key.return) {
      const picked = levels[index]
      if (picked) onPick(picked.id)
      return
    }
    // 1..8 quick-jump (mirrors the plain-loop numbered picker).
    const digit = Number(input)
    if (Number.isInteger(digit) && digit >= 1 && digit <= levels.length) {
      const picked = levels[digit - 1]
      if (picked) onPick(picked.id)
    }
  }, { isActive: true })

  return (
    <PanelFrame title="◇ reasoning effort" hint="↑↓ move · 1-8 jump · Enter switch · Esc close">
      {levels.map((meta, row) => {
        const marker = meta.id === current ? '*' : ' '
        const label = `${marker} ${meta.id}  ${meta.hint} (${meta.detail})`
        return row === index
          ? <SelectedRow key={meta.id} text={label} width={60} />
          : <Text key={meta.id} color={BODY}>{label}</Text>
      })}
    </PanelFrame>
  )
}

/** Single-line field with caret (used for ids, URLs; secret masks as •). */
export function LineInput({ value, onChange, onSubmit, onCancel, secret = false }: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onCancel: () => void
  secret?: boolean
}): React.JSX.Element {
  const [cursor, setCursor] = useState(value.length)
  const safeCursor = Math.max(0, Math.min(cursor, [...value].length))

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      onSubmit(value)
      return
    }
    const chars = [...value]
    if (key.backspace || (key.ctrl && input === 'h')) {
      if (safeCursor > 0) {
        onChange([...chars.slice(0, safeCursor - 1), ...chars.slice(safeCursor)].join(''))
        setCursor(safeCursor - 1)
      }
      return
    }
    if (key.delete) {
      if (safeCursor < chars.length) {
        onChange([...chars.slice(0, safeCursor), ...chars.slice(safeCursor + 1)].join(''))
      }
      return
    }
    if (key.leftArrow) {
      setCursor(safeCursor - 1)
      return
    }
    if (key.rightArrow) {
      setCursor(safeCursor + 1)
      return
    }
    if (key.home || (key.ctrl && input === 'a')) {
      setCursor(0)
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCursor(chars.length)
      return
    }
    if (key.upArrow || key.downArrow || key.tab || key.ctrl || key.meta) return
    if (!input || input.includes('\n') || input.includes('\r')) return
    onChange([...chars.slice(0, safeCursor), ...[...input], ...chars.slice(safeCursor)].join(''))
    setCursor(safeCursor + [...input].length)
  }, { isActive: true })

  const shown = secret ? '•'.repeat([...value].length) : value
  const glyphs = [...shown]
  const before = glyphs.slice(0, safeCursor).join('')
  const at = glyphs[safeCursor] ?? ' '
  const after = glyphs.slice(safeCursor + 1).join('')
  return (
    <Text>
      <Text color={ACCENT}>› </Text>
      <Text color={BODY}>{before}</Text>
      <Text backgroundColor={ACCENT} color="black">{at}</Text>
      <Text color={BODY}>{after}</Text>
    </Text>
  )
}
