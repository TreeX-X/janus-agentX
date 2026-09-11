/**
 * @file Mid-turn confirmation panel for `ask_user` (opencode `question` parity).
 * @description Modal box above the composer: one question at a time with
 * numbered options, single/multi select, free-form custom input, and whole-
 * call confirm/cancel. Owns its own `useInput` (mounted = active), so the
 * App shell only disables the composer and suspends global keys while open.
 * Cancellation always covers the whole call (Esc = cancel all, never skip).
 */
import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ASK_MAX_CUSTOM_CHARS } from '@janus-agent/chat-core'
import type { AskUserPortAnswer } from '@janus-agent/janus-agent'
import { truncateToWidth } from './composer-state.js'
import { LineInput, PanelFrame, SelectedRow } from './palette.js'
import type { QuestionView } from './store.js'
import { BODY, MUTED } from './palette.js'

export function QuestionPanel({ view, onResolve }: {
  view: QuestionView
  onResolve: (answer: AskUserPortAnswer) => void
}): React.JSX.Element {
  const total = view.questions.length
  const [index, setIndex] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [checked, setChecked] = useState<readonly number[]>([])
  const [customMode, setCustomMode] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [picked, setPicked] = useState<Array<{ header: string; selected: string[]; custom?: string }>>([])

  const current = view.questions[Math.min(index, total - 1)]
  const options = useMemo(() => current?.options ?? [], [current])
  // Navigable rows: options plus a visible custom-input row when the call
  // allows it (design/janus-TUI-design.html). The custom row opens the
  // in-panel LineInput; the bottom composer stays disabled so key routing
  // never splits between panel and composer mid-question.
  const customRow = view.allowCustom && !customMode ? 1 : 0
  const rowCount = options.length + customRow
  const highlightedCustom = customRow === 1 && highlight >= options.length

  const submitQuestion = (
    selected: string[],
    custom: string | undefined,
    questionHeader: string,
  ): void => {
    const entry = custom ? { header: questionHeader, selected, custom } : { header: questionHeader, selected }
    const next = [...picked, entry]
    if (index + 1 >= total) {
      onResolve({ status: 'answered', answers: next })
      return
    }
    setPicked(next)
    setIndex(index + 1)
    setHighlight(0)
    setChecked([])
    setCustomMode(false)
    setCustomDraft('')
  }

  useInput((input, key) => {
    if (!current) {
      onResolve({ status: 'cancelled' })
      return
    }
    // Whole-call cancel from anywhere in the panel.
    if (key.escape) {
      onResolve({ status: 'cancelled' })
      return
    }
    if (customMode) return // LineInput owns keys; Esc there cancels via onCancel.
    if (key.upArrow) {
      setHighlight((prev) => (prev - 1 + rowCount) % Math.max(1, rowCount))
      return
    }
    if (key.downArrow) {
      setHighlight((prev) => (prev + 1) % Math.max(1, rowCount))
      return
    }
    // Quick-jump digits double as single-select confirm for single-choice.
    const digit = Number(input)
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return && Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      if (current.multiple) {
        const at = digit - 1
        setChecked((prev) => (prev.includes(at) ? prev.filter((row) => row !== at) : [...prev, at]))
      } else {
        const option = options[digit - 1]
        if (option) submitQuestion([option.label], undefined, current.header)
      }
      return
    }
    if (input === ' ' && current.multiple && !highlightedCustom) {
      const at = highlight
      setChecked((prev) => (prev.includes(at) ? prev.filter((row) => row !== at) : [...prev, at]))
      return
    }
    // Custom free-form answer (only when the call allows it).
    if ((input === 'c' || input === 'C') && view.allowCustom && !key.ctrl && !key.meta) {
      setCustomMode(true)
      return
    }
    if (key.return) {
      if (highlightedCustom) {
        setCustomMode(true)
        return
      }
      if (current.multiple) {
        const selected = [...checked]
          .sort((a, b) => a - b)
          .map((row) => options[row]?.label)
          .filter((label): label is string => typeof label === 'string')
        if (selected.length === 0) return // require at least one pick
        submitQuestion(selected, undefined, current.header)
        return
      }
      const option = options[highlight] ?? options[0]
      if (option) submitQuestion([option.label], undefined, current.header)
    }
  }, { isActive: !customMode })

  if (!current) return <Box><Text color={MUTED}>no questions</Text></Box>

  const labelWidth = 56
  return (
    <PanelFrame
      title={`? confirm plan · ${index + 1}/${total} · ${current.header}`}
      hint={current.multiple
        ? '↑↓ move · Space check · 1-6 toggle · Enter confirm · c custom input · Esc cancel all'
        : '↑↓ move · 1-6 jump · Enter confirm · c custom input · Esc cancel all'}
    >
      <Text color={BODY}>{truncateToWidth(current.question, 76)}</Text>
      {options.map((option, row) => {
        const mark = current.multiple ? (checked.includes(row) ? '◉' : '○') : row === highlight ? '▸' : ' '
        const label = `${mark} ${row + 1} ${option.label}${option.description ? `  ${option.description}` : ''}`
        const selected = current.multiple ? checked.includes(row) : row === highlight
        return selected
          ? <SelectedRow key={row} text={label} width={labelWidth} />
          : <Text key={row} color={BODY}>{truncateToWidth(label, labelWidth)}</Text>
      })}
      {customRow === 1 ? (
        highlightedCustom
          ? <SelectedRow key="custom" text="▸ c · 自定义输入…" width={labelWidth} />
          : <Text key="custom" color={MUTED}>{truncateToWidth('  c · 自定义输入…', labelWidth)}</Text>
      ) : null}
      {customMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={MUTED}>custom answer (Enter confirm · Esc back):</Text>
          <LineInput
            value={customDraft}
            onChange={setCustomDraft}
            onSubmit={(value) => {
              const custom = value.trim().slice(0, ASK_MAX_CUSTOM_CHARS)
              if (!custom) {
                setCustomMode(false)
                return
              }
              submitQuestion([], custom, current.header)
            }}
            onCancel={() => setCustomMode(false)}
          />
        </Box>
      ) : null}
    </PanelFrame>
  )
}
