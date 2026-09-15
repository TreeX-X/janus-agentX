/**
 * @file Overlay UI primitives for the Ink TUI: command palette + line input.
 * @description Modal boxes rendered above the composer. Each owns its own
 * `useInput` (mounted = active), so the App shell only needs to disable the
 * composer and ignore global keys while an overlay is open.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { LOGO_TONE, TUI_CHROME } from '../logo.js'
import { EFFORT_META, type EffortLevel } from '../effort.js'
import { displayWidth, padToWidth, truncateToWidth, wrapToWidth } from './composer-state.js'

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

/**
 * Wrapped read-only row: `prefix` (marker/number, kept on line one) plus a
 * wrappable `body` shown in full across as many lines as needed.
 * Continuation lines hang under the body start. `selected` paints every
 * line full-bleed so long options/todos stay highlighted end to end.
 * Replaces single-line `truncateToWidth` rows where cutting text hides
 * meaning (todo items, question options).
 */
export function WrappedRow({ prefix, body, width, selected = false, color }: {
  prefix: string
  body: string
  width: number
  selected?: boolean
  color?: string
}): React.JSX.Element {
  const headWidth = displayWidth(prefix)
  const wrapped = wrapToWidth(body, Math.max(1, width - headWidth))
  const indent = ' '.repeat(headWidth)
  const lines = wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `${indent}${line}`))
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => selected
        ? <SelectedRow key={index} text={line} width={width} />
        : <Text key={index} color={color ?? BODY}>{line}</Text>)}
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

/** One row of the provider switcher (bare /provider): display fields only. */
export interface ProviderPanelEntry {
  id: string
  name?: string
  modelCount: number
  keySource: string | null
}

/** Interactive provider switcher (bare /provider): arrows + filter + Enter, Esc closes. */
export function ProviderPanel({ items, activeId, onPick, onClose }: {
  items: ProviderPanelEntry[]
  activeId: string
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((item) => item.id === activeId)))
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const rows = needle
      ? items.filter((item) => `${item.id} ${item.name ?? ''}`.toLowerCase().includes(needle))
      : items
    return rows
  }, [items, filter])
  const selected = Math.min(index, Math.max(0, visible.length - 1))

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (visible.length === 0) {
      if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1))
        setIndex(0)
      } else if (input && !key.ctrl && !key.meta && !key.tab && !input.includes('\n') && !input.includes('\r')) {
        setFilter((current) => current + input)
        setIndex(0)
      }
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
      if (picked) onPick(picked.id)
      return
    }
    // 1..N quick-jump (mirrors the plain-loop numbered picker).
    const digit = Number(input)
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return && Number.isInteger(digit) && digit >= 1 && digit <= visible.length) {
      const picked = visible[digit - 1]
      if (picked) onPick(picked.id)
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
    <PanelFrame title="◇ provider" hint="↑↓ move · type filter · 1-N jump · Enter switch · Esc close">
      <Text>
        <Text color={MUTED}>› </Text>
        <Text color={BODY}>{filter}</Text>
        <Text backgroundColor={MUTED} color="black"> </Text>
      </Text>
      {visible.length === 0 ? <Text color={MUTED}>(no match — add one with /connect)</Text> : null}
      {visible.map((item, row) => {
        const label = `${item.id === activeId ? '*' : ' '} ${item.id}${item.name ? ` (${item.name})` : ''}  ${item.modelCount} model(s)  ${item.keySource ? 'key ✓' : 'key ✗'}`
        return row === selected
          ? <SelectedRow key={item.id} text={label} width={60} />
          : <Text key={item.id} color={BODY}>{label}</Text>
      })}
    </PanelFrame>
  )
}

/** Interactive model switcher (bare /model): arrows + filter + Enter, Esc closes. */
export function ModelPanel({ providerId, models, active, loadModels, onPick, onClose }: {
  providerId: string
  models: string[]
  active: string | undefined
  /**
   * Live fallback for catalog-empty (open-world) providers: resolves the
   * `/models` listing, or null when unavailable (no key / probe failed).
   * Null and empty both fall back to free input; never blocks the panel.
   */
  loadModels?: () => Promise<string[] | null>
  onPick: (modelId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [remote, setRemote] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(models.length === 0 && loadModels !== undefined)
  // Catalog wins; the probe runs once per panel mount for catalog-empty
  // providers (the loader closure is fresh every host render by design).
  useEffect(() => {
    if (models.length > 0 || loadModels === undefined) return
    let cancelled = false
    setLoading(true)
    loadModels().then(
      (listed) => { if (!cancelled) { setRemote(listed); setLoading(false) } },
      () => { if (!cancelled) { setRemote(null); setLoading(false) } },
    )
    return () => { cancelled = true }
    // Runs once per mount; re-probing on every host render would spin forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const list = models.length > 0 ? models : (remote ?? [])
  const showCustom = !loading && list.length === 0
  const [index, setIndex] = useState(() => Math.max(0, list.findIndex((model) => model === active)))
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? list.filter((model) => model.toLowerCase().includes(needle)) : list
  }, [list, filter])
  const selected = Math.min(index, Math.max(0, visible.length - 1))
  const [custom, setCustom] = useState('')

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (loading || showCustom) return
    if (visible.length === 0) {
      if (key.return && filter.trim()) {
        onPick(filter.trim())
        return
      }
      if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1))
        setIndex(0)
      } else if (input && !key.ctrl && !key.meta && !key.tab && !input.includes('\n') && !input.includes('\r')) {
        setFilter((current) => current + input)
        setIndex(0)
      }
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
    // 1..N quick-jump (mirrors the plain-loop numbered picker).
    const digit = Number(input)
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return && Number.isInteger(digit) && digit >= 1 && digit <= visible.length) {
      const picked = visible[digit - 1]
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

  if (loading) {
    return (
      <PanelFrame title={`◇ model — ${providerId}`} hint="Esc keep current">
        <Text color={MUTED}>loading models …</Text>
      </PanelFrame>
    )
  }

  if (showCustom) {
    return (
      <PanelFrame title={`◇ model — ${providerId}`} hint="type model id · Enter switch · Esc keep current">
        <LineInput
          value={custom}
          onChange={setCustom}
          onSubmit={(value) => {
            if (!value.trim()) {
              onClose()
              return
            }
            onPick(value.trim())
          }}
          onCancel={onClose}
        />
      </PanelFrame>
    )
  }

  return (
    <PanelFrame title={`◇ model — ${providerId}`} hint="↑↓ move · type filter · 1-N jump · Enter switch · Esc close">
      <Text>
        <Text color={MUTED}>› </Text>
        <Text color={BODY}>{filter}</Text>
        <Text backgroundColor={MUTED} color="black"> </Text>
      </Text>
      {visible.length === 0 ? <Text color={MUTED}>(no match — Enter uses the filter text)</Text> : null}
      {visible.map((model, row) => {
        const label = `${model === active ? '*' : ' '} ${model}`
        return row === selected
          ? <SelectedRow key={model} text={label} width={60} />
          : <Text key={model} color={BODY}>{label}</Text>
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
