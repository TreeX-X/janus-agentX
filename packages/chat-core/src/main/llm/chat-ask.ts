/**
 * @file Mid-turn plan confirmation core (opencode `question` parity).
 * @description Pure helpers with no Electron/DB/singleton dependency.
 * The model calls `ask_user` with 1-4 questions; each carries 2-6 options
 * plus an optional free-form custom answer. Hosts render the questions
 * (Ink panel / plain numbered picker), the user answers or cancels the
 * whole call, and the answer flows back as the tool result so the turn
 * continues. Cancellation always covers the whole call (never partial).
 */

/** Model-facing tool name (snake_case, aligned with `todo_write`). */
export const ASKUSER_TOOL_NAME = 'ask_user'

/** Max questions per call (opencode parity). */
export const ASK_MAX_QUESTIONS = 4
/** Option bounds per question. */
export const ASK_MIN_OPTIONS = 2
export const ASK_MAX_OPTIONS = 6
/** Field budgets (chars). */
export const ASK_MAX_QUESTION_CHARS = 500
export const ASK_MAX_HEADER_CHARS = 30
export const ASK_MAX_LABEL_CHARS = 60
export const ASK_MAX_DESCRIPTION_CHARS = 200
export const ASK_MAX_CUSTOM_CHARS = 500
/** Max `ask_user` calls per turn (loop-enforced budget). */
export const ASK_MAX_CALLS_PER_TURN = 2
/** Bounded tool-result content returned to the model. */
export const ASK_MAX_RESULT_CHARS = 2000

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserOption[]
  multiple: boolean
}

export interface AskUserRequest {
  questions: AskUserQuestion[]
  allowCustom: boolean
}

export interface AskUserAnswerItem {
  header: string
  selected: string[]
  custom?: string
}

export type AskUserAnswer =
  | { status: 'answered'; answers: AskUserAnswerItem[] }
  | { status: 'cancelled' }

/**
 * Condensed `question.txt` contract for the model-facing tool description.
 * Mirrors opencode usage notes: custom answer is automatic, answers return
 * as label arrays, recommended option goes first.
 */
export const ASKUSER_TOOL_DESCRIPTION = [
  'Ask the user questions during execution. Use when a decision blocks progress:',
  'ambiguous scope, mutually exclusive implementation choices, or a consequential plan needing confirmation.',
  'Answers return as arrays of option labels per question; a cancelled call returns an error instead.',
  'Rules: ask at most 4 questions per call and at most twice per turn; 2-6 options per question with a one-line tradeoff each;',
  'put the recommended option first and append " (Recommended)" to its label; do not add an "Other" option',
  '(a custom-answer entry is added automatically unless allowCustom=false);',
  'never ask when the request is unambiguous — proceed with stated assumptions instead.',
].join(' ')

/** System-prompt guidance (alongside TODO_GUIDANCE in system-prompt-builder). */
export const ASKUSER_GUIDANCE = [
  'User interaction: use ask_user (max 2 calls per turn, up to 4 questions total) when a decision blocks progress: ambiguous scope, mutually exclusive implementations, or a consequential/destructive plan.',
  'Prefer proceeding with stated assumptions for trivial or reversible work.',
  'One question per decision; 2-6 options each with a one-line tradeoff; recommended first with "(Recommended)".',
  'After answers arrive, restate the chosen plan in one line and continue without re-asking.',
].join('\n')

export type AskValidationResult =
  | { ok: true; request: AskUserRequest }
  | { ok: false; error: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Transactional validation for one `ask_user` call. Fails closed with a
 * precise, correctable message (same contract as validateTodoList).
 */
export function validateAskUserRequest(input: unknown): AskValidationResult {
  const record = asRecord(input)
  const questions = record?.questions
  if (!Array.isArray(questions)) {
    return { ok: false, error: 'questions must be an array of {question, header, options, multiple}.' }
  }
  if (questions.length === 0) {
    return { ok: false, error: 'Ask at least 1 question. Pass 1-4 questions per call.' }
  }
  if (questions.length > ASK_MAX_QUESTIONS) {
    return { ok: false, error: `Too many questions (${questions.length}). Keep it to ${ASK_MAX_QUESTIONS} or fewer per call.` }
  }
  const allowCustom = record?.allowCustom === undefined ? true : record.allowCustom === true
  if (record?.allowCustom !== undefined && typeof record.allowCustom !== 'boolean') {
    return { ok: false, error: 'allowCustom must be a boolean.' }
  }
  const parsed: AskUserQuestion[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const item = asRecord(questions[index])
    const tag = `Question #${index + 1}`
    const question = typeof item?.question === 'string' ? item.question.trim() : ''
    const header = typeof item?.header === 'string' ? item.header.trim() : ''
    if (!question) return { ok: false, error: `${tag} has empty question. Ask one concrete decision per question.` }
    if (question.length > ASK_MAX_QUESTION_CHARS) {
      return { ok: false, error: `${tag} exceeds ${ASK_MAX_QUESTION_CHARS} chars. Shorten it.` }
    }
    if (!header) return { ok: false, error: `${tag} has empty header. Give a short (max 30 chars) label.` }
    if (header.length > ASK_MAX_HEADER_CHARS) {
      return { ok: false, error: `${tag} header exceeds ${ASK_MAX_HEADER_CHARS} chars. Shorten it.` }
    }
    const options = item?.options
    if (!Array.isArray(options)) {
      return { ok: false, error: `${tag} options must be an array of {label, description}.` }
    }
    if (options.length < ASK_MIN_OPTIONS || options.length > ASK_MAX_OPTIONS) {
      return { ok: false, error: `${tag} needs ${ASK_MIN_OPTIONS}-${ASK_MAX_OPTIONS} options (got ${options.length}).` }
    }
    const seen = new Set<string>()
    const parsedOptions: AskUserOption[] = []
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = asRecord(options[optionIndex])
      const label = typeof option?.label === 'string' ? option.label.trim() : ''
      const description = typeof option?.description === 'string' ? option.description.trim() : ''
      if (!label) return { ok: false, error: `${tag} option #${optionIndex + 1} has empty label.` }
      if (label.length > ASK_MAX_LABEL_CHARS) {
        return { ok: false, error: `${tag} option #${optionIndex + 1} label exceeds ${ASK_MAX_LABEL_CHARS} chars.` }
      }
      if (description.length > ASK_MAX_DESCRIPTION_CHARS) {
        return { ok: false, error: `${tag} option #${optionIndex + 1} description exceeds ${ASK_MAX_DESCRIPTION_CHARS} chars.` }
      }
      const key = label.toLowerCase()
      if (seen.has(key)) {
        return { ok: false, error: `${tag} has duplicate option label "${label}". Make each label unique.` }
      }
      seen.add(key)
      parsedOptions.push(description ? { label, description } : { label })
    }
    const multiple = item?.multiple === undefined ? false : item.multiple === true
    if (item?.multiple !== undefined && typeof item.multiple !== 'boolean') {
      return { ok: false, error: `${tag} multiple must be a boolean.` }
    }
    parsed.push({ question, header, options: parsedOptions, multiple })
  }
  return { ok: true, request: { questions: parsed, allowCustom } }
}

/** Serialize an answered call for the model (bounded, machine-readable). */
export function formatAskResultContent(answer: Extract<AskUserAnswer, { status: 'answered' }>): string {
  const payload = {
    answers: answer.answers.map((item) => ({
      header: item.header,
      selected: item.selected,
      ...(item.custom ? { custom: item.custom } : {}),
    })),
  }
  const text = JSON.stringify(payload)
  return text.length > ASK_MAX_RESULT_CHARS ? `${text.slice(0, ASK_MAX_RESULT_CHARS - 1)}…` : text
}

/** Content returned when the user cancels the whole call. */
export function askCancelledContent(): string {
  return 'Question cancelled by user (no answers recorded). Proceed with safest defaults or stop and explain.'
}

/** One-line history note persisted into the conversation (resume-safe). */
export function formatAskHistoryNote(answer: AskUserAnswer): string | null {
  if (answer.status !== 'answered') return null
  const parts = answer.answers.map((item) => {
    const picked = item.selected.join('+') || '(custom)'
    return `${item.header} → ${item.custom ? `${picked} + "${item.custom.slice(0, 80)}"` : picked}`
  })
  return parts.length > 0 ? `Confirmed via ask_user: ${parts.join('; ')}` : null
}

/** Compact card summary for tool-display (`Q1→REST; Q2→JWT+Refresh`). */
export function formatAskSummary(answer: AskUserAnswer): string {
  if (answer.status !== 'answered') return 'question cancelled'
  return answer.answers
    .map((item, index) => `Q${index + 1}→${item.selected.join('+') || 'custom'}`)
    .join('; ')
}

/** Defensive clone for event/IPC boundaries. */
export function cloneAskRequest(request: AskUserRequest): AskUserRequest {
  return {
    allowCustom: request.allowCustom,
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiple: question.multiple,
      options: question.options.map((option) => ({ ...option })),
    })),
  }
}
