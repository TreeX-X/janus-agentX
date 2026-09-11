/**
 * @file Pure question-picker logic for `ask_user` (no React/Ink/IO).
 * @description Shared by the plain-loop numbered picker (`repl.ts`) and the
 * Ink `QuestionPanel`: answer parsing/validation plus prompt-row formatting.
 * Cancellation always covers the whole call (never partial answers).
 */
import { ASK_MAX_CUSTOM_CHARS } from '@janus-agent/chat-core'
import type { AskUserPortRequest } from '@janus-agent/janus-agent'

export interface QuestionAnswerItem {
  header: string
  selected: string[]
  custom?: string
}

export type PlainPickerParse =
  | { action: 'answer'; selected: string[] }
  | { action: 'custom' }
  | { action: 'cancel' }
  | { action: 'error'; message: string }
  | { action: 'empty' }

const CANCEL_TOKENS = new Set(['q', 'quit', 'cancel', 'esc', 'n', 'no'])

function optionLabels(question: AskUserPortRequest['questions'][number]): string[] {
  return question.options.map((option) => option.label)
}

/**
 * Parse one line of plain-picker input for a single question.
 * Numbers (1-based, `1,3` for multi), exact labels (case-insensitive),
 * `c` = custom input, `q` = cancel the whole call, empty = re-ask.
 */
export function parseQuestionPickerInput(
  raw: string,
  question: AskUserPortRequest['questions'][number],
  allowCustom: boolean,
): PlainPickerParse {
  const trimmed = raw.trim()
  if (!trimmed) return { action: 'empty' }
  const lowered = trimmed.toLowerCase()
  if (CANCEL_TOKENS.has(lowered)) return { action: 'cancel' }
  if (allowCustom && (lowered === 'c' || lowered === 'custom')) return { action: 'custom' }
  const labels = optionLabels(question)
  const loweredLabels = labels.map((label) => label.toLowerCase())
  const parts = question.multiple ? trimmed.split(',').map((part) => part.trim()).filter(Boolean) : [trimmed]
  if (parts.length === 0) return { action: 'empty' }
  if (!question.multiple && parts.length !== 1) {
    return { action: 'error', message: `Pick one option (1-${labels.length}).` }
  }
  const selected: string[] = []
  for (const part of parts) {
    const asNumber = Number(part)
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= labels.length) {
      const label = labels[asNumber - 1]
      if (label && !selected.includes(label)) selected.push(label)
      continue
    }
    const index = loweredLabels.indexOf(part.toLowerCase())
    if (index >= 0) {
      const label = labels[index]
      if (label && !selected.includes(label)) selected.push(label)
      continue
    }
    return { action: 'error', message: `Unknown option "${part}". Pick 1-${labels.length} or the exact label.` }
  }
  if (selected.length === 0) return { action: 'empty' }
  return { action: 'answer', selected }
}

/** Validate + bound a custom free-form answer. */
export function normalizeCustomAnswer(raw: string): { ok: true; custom: string } | { ok: false; error: string } {
  const custom = raw.trim()
  if (!custom) return { ok: false, error: 'Custom answer is empty.' }
  if (custom.length > ASK_MAX_CUSTOM_CHARS) {
    return { ok: false, error: `Custom answer exceeds ${ASK_MAX_CUSTOM_CHARS} chars.` }
  }
  return { ok: true, custom }
}

/** Numbered rows for one question (`*` unused here; kept for picker parity). */
export function questionPickerRows(
  question: AskUserPortRequest['questions'][number],
): string[] {
  return question.options.map((option, index) => {
    const suffix = option.description ? ` — ${option.description}` : ''
    return `  ${index + 1} ${option.label}${suffix}`
  })
}

/** One-line header for prompts: `◇ ask_user 1/2: <question>`. */
export function questionPromptHead(index: number, total: number, header: string): string {
  return `◇ ask_user ${index + 1}/${total} [${header}]`
}
