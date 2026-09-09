/**
 * @file Overlay UI primitives for the Ink TUI: command palette + line input.
 * @description Modal boxes rendered above the composer. Each owns its own
 * `useInput` (mounted = active), so the App shell only needs to disable the
 * composer and ignore global keys while an overlay is open.
 */
import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { LOGO_TONE } from '../logo.js'
import { padToWidth, truncateToWidth } from './composer-state.js'

export const ACCENT = LOGO_TONE.orange
export const MUTED = LOGO_TONE.dim
export const BODY = LOGO_TONE.lit

export function PanelFrame({ title, hint, children }: {
  title: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
      <Text color={ACCENT} bold>{title}</Text>
      {children}
      <Text color={MUTED}>{hint}</Text>
    </Box>
  )
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
          return <Text key={item.id} backgroundColor={ACCENT} color="black">{padToWidth(truncateToWidth(label, 60), 60)}</Text>
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
          ? <Text key={mode.id} backgroundColor={ACCENT} color="black">{padToWidth(truncateToWidth(label, 60), 60)}</Text>
          : <Text key={mode.id} color={BODY}>{label}</Text>
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
