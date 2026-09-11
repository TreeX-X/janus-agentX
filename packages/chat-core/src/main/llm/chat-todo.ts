/**
 * @file Chat todo list core (opencode `todowrite` parity, Codex-style display).
 * @description Pure helpers with no Electron/DB/singleton dependency.
 * The model is the sole writer via the `todo_write` loop tool (see
 * `@janus-agent/janus-agent`); renderers keep a read-only mirror above the
 * composer and clear it on conversation switch/reset. Deliberately no
 * `priority`/`position` in v1 (see docs/janus-agent-capability-plan.md §4).
 */

export type ChatTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface ChatTodoItem {
  content: string
  status: ChatTodoStatus
}

/** Model-facing tool name (snake_case, aligned with `workspace_*`). */
export const TODOWRITE_TOOL_NAME = 'todo_write'

/** Hard cap: mirrors opencode `MAX_TODOS=20`. */
export const TODO_MAX_ITEMS = 20

/** Per-item content budget: mirrors opencode `CONTENT 200`. */
export const TODO_MAX_CONTENT_CHARS = 200

const TODO_STATUSES: readonly ChatTodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/**
 * Condensed `todowrite.txt` contract for the model-facing tool description.
 * Full opencode text lives in docs/janus-agent-capability-plan.md §2.
 */
export const TODOWRITE_TOOL_DESCRIPTION = [
  'Create and maintain a structured task list for the current coding session.',
  'Use proactively when the task needs 3+ distinct steps, non-trivial planning, or the user gives multiple tasks.',
  'States: pending (not started), in_progress (exactly ONE at a time), completed, cancelled.',
  'Rules: update status in real time, never batch completions; mark completed only after the work plus verification is done;',
  'keep exactly one in_progress while work remains; if blocked, keep it in_progress and add a follow-up todo;',
  'never use a markdown checklist instead of this tool.',
].join(' ')

export type TodoValidationResult =
  | { ok: true; todos: ChatTodoItem[] }
  | { ok: false; error: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Transactional validation for a full-list `todo_write` call.
 * The list is always replaced wholesale (never appended), so the UI above
 * the composer can simply re-render on every `todo_update` event.
 */
export function validateTodoList(input: unknown): TodoValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'todos must be an array of {content, status}.' }
  }
  if (input.length === 0) {
    return { ok: false, error: 'Todo list must not be empty. Pass the full updated list (1-20 items).' }
  }
  if (input.length > TODO_MAX_ITEMS) {
    return { ok: false, error: `Todo list exceeds ${TODO_MAX_ITEMS} items. Keep it to ${TODO_MAX_ITEMS} or fewer.` }
  }
  const todos: ChatTodoItem[] = []
  for (let index = 0; index < input.length; index += 1) {
    const record = asRecord(input[index])
    const content = typeof record?.content === 'string' ? record.content.trim() : ''
    const status = record?.status
    if (!content) {
      return { ok: false, error: `Todo #${index + 1} has empty content. Give each todo a specific, actionable description.` }
    }
    if (content.length > TODO_MAX_CONTENT_CHARS) {
      return { ok: false, error: `Todo #${index + 1} exceeds ${TODO_MAX_CONTENT_CHARS} chars. Shorten it.` }
    }
    if (typeof status !== 'string' || !(TODO_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: `Todo #${index + 1} has invalid status "${String(status)}". Use pending|in_progress|completed|cancelled.` }
    }
    todos.push({ content, status: status as ChatTodoStatus })
  }
  const active = todos.filter((todo) => todo.status === 'in_progress')
  if (active.length > 1) {
    return { ok: false, error: 'Only one todo may be in_progress at a time. Complete or requeue the others first.' }
  }
  return { ok: true, todos }
}

/** Snapshot the current list into a bounded system message (null when empty). */
export function formatTodoStateMessage(todos: readonly ChatTodoItem[]): string | null {
  if (todos.length === 0) return null
  const lines = todos.slice(0, TODO_MAX_ITEMS).map((todo) => `- [${todo.status}] ${todo.content}`)
  return [
    'Current task list (via todo_write, most recent last as ordered).',
    'Continue from it; keep exactly one in_progress and update it in real time.',
    ...lines,
  ].join('\n')
}

export interface TodoSummary {
  total: number
  done: number
  open: number
  current?: string
}

/** Single-line sticky data: `n/m` counts plus the active item. */
export function summarizeTodos(todos: readonly ChatTodoItem[]): TodoSummary {
  const total = todos.length
  const done = todos.filter((todo) => todo.status === 'completed').length
  const current = todos.find((todo) => todo.status === 'in_progress')?.content
  return { total, done, open: total - done, ...(current !== undefined ? { current } : {}) }
}

/** Sticky visibility rule (mirrors opencode sidebar): hide when empty or all done. */
export function hasOpenTodos(todos: readonly ChatTodoItem[]): boolean {
  return todos.length > 0 && todos.some((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
}

/** Defensive clone for IPC boundaries (callers must not retain references). */
export function cloneTodos(todos: readonly ChatTodoItem[]): ChatTodoItem[] {
  return todos.map((todo) => ({ content: todo.content, status: todo.status }))
}
