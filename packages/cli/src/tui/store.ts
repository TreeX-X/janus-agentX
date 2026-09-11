/**
 * @file Pure TUI state reducer (no Ink, no IO, unit tested).
 * @description A single ordered timeline per discussion: user / assistant /
 * thinking / tool / info / error / notice blocks in stream order (pi and
 * opencode render the same interleaving — thinking, then the tool it led to,
 * then more thinking — instead of dumping all tool cards at the end).
 * Mirrors the §4.3 ChatAgentEvent→UI table shared with the plain loop.
 */
import type { ChatAgentEvent, ChatTodoItem } from '@janus-agent/chat-core'
import type { TracePreview } from '../trace-preview.js'
import type { CliDisplayEvent, ToolDisplay } from '../tool-display.js'

export type TimelineKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'info'
  | 'error'
  | 'notice'

export interface TimelineBlock {
  id: string
  kind: TimelineKind
  /** Streamed body for user/assistant/thinking/info/error/notice blocks. */
  text: string
  callId?: string
  toolName?: string
  toolStatus?: ToolCardStatus
  /** Argument keys while running; kept as the card caption when done. */
  toolDetail?: string
  /** Post-turn outcome caption from tool traces (e.g. path + sha). */
  toolSummary?: string
  /** Post-turn file preview: compact diff/stat lines for edits and creates. */
  toolPreview?: string[]
  display?: ToolDisplay
  startedAt?: number
  endedAt?: number
  argumentChars?: number
}

export type ToolCardStatus = 'preparing' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ApprovalView {
  toolName: string
  workspaceId: string
  actionRisk: string
  summary?: string
  paths?: string[]
  detail?: string
}

export interface QuestionOptionView {
  label: string
  description?: string
}

export interface QuestionItemView {
  question: string
  header: string
  options: QuestionOptionView[]
  multiple: boolean
}

export interface QuestionView {
  callId: string
  questions: QuestionItemView[]
  allowCustom: boolean
}

export type TuiStatus = 'idle' | 'thinking' | 'error'

export interface TuiContextLabels {
  modelLabel: string
  workspaceLabel: string
  approvalLabel: string
  conversationLabel: string
}

/* ── Token + footer formatting (opencode bottom-bar shape) ───────────────
   Session totals live in the footer (`/help · ctrl+p · <tokens>`); per-turn
   counters stay for the turn-done caption. Compact `12.3k/1.2M` keeps the
   single-line bar from wrapping on narrow terminals. */

function trimCompact(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${Math.trunc(rounded)}` : `${rounded}`
}

/** Compact token count: raw below 1k, `12.3k` / `1.2M` above (opencode style). */
export function formatTokenCount(value: number): string {
  const count = Math.max(0, Math.floor(value))
  if (count >= 1_000_000) return `${trimCompact(count / 1_000_000)}M`
  if (count >= 1_000) return `${trimCompact(count / 1_000)}k`
  return `${count}`
}

/** `12 in / 8 out` segment shared by the footer and the turn-done caption. */
export function formatTokenUsage(promptTokens: number, completionTokens: number): string {
  return `${formatTokenCount(promptTokens)} in / ${formatTokenCount(completionTokens)} out`
}

export interface FooterSegments {
  conversationLabel?: string
  statusText?: string
  sessionPromptTokens?: number
  sessionCompletionTokens?: number
  /** Scrolled-up rows; 0/undefined hides the badge (no wheel/scroll-key hints). */
  hiddenRows?: number
}

/**
 * Right-side status meta for the split bottom bar (design/janus-TUI-design.html):
 * `[conv · ][status · ]<tokens>[ · ↑N]`. The left side owns the static key
 * hints (`[Enter] Send · …`), so this carries only live state. Empty when
 * there is nothing to report (callers hide the right cell).
 */
export function buildFooterText(segments: FooterSegments): string {
  const parts: string[] = []
  if (segments.conversationLabel) parts.push(segments.conversationLabel)
  if (segments.statusText) parts.push(segments.statusText)
  const prompt = segments.sessionPromptTokens ?? 0
  const completion = segments.sessionCompletionTokens ?? 0
  if (prompt > 0 || completion > 0) parts.push(formatTokenUsage(prompt, completion))
  const hidden = segments.hiddenRows ?? 0
  if (hidden > 0) parts.push(`↑${Math.floor(hidden)}`)
  return parts.join(' · ')
}

export interface TuiState extends TuiContextLabels {
  blocks: TimelineBlock[]
  /** Thinking expansion (pi ctrl+t style). Collapsed by default, always shown. */
  thinkingExpanded: boolean
  toolsExpanded: boolean
  /** Todo box expansion (ctrl+e). Collapsed single-line summary by default. */
  todosExpanded: boolean
  /** Live todo mirror for the sticky bar above the composer (empty = hidden). */
  todos: ChatTodoItem[]
  activeBlockId?: string
  turnStartedAt?: number
  turnEndedAt?: number
  /** Current-turn tokens (reset on turn-start; shown in the turn-done caption). */
  promptTokens: number
  completionTokens: number
  /** Session totals (opencode bottom-bar shape; survive across turns). */
  sessionPromptTokens: number
  sessionCompletionTokens: number
  status: TuiStatus
  statusText: string
  awaitingApproval: ApprovalView | null
  /** Live `ask_user` gate above the composer (null = no pending question). */
  awaitingQuestion: QuestionView | null
}

export type TuiAction =
  | { type: 'turn-start' }
  | { type: 'agent-event'; event: ChatAgentEvent }
  | { type: 'turn-done'; cancelled: boolean; assistantText: string }
  | { type: 'turn-traces'; traces: TracePreview[] }
  | { type: 'user-message'; text: string }
  | { type: 'info'; text: string }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'toggle-thinking' }
  | { type: 'toggle-tools' }
  | { type: 'toggle-todos' }
  | CliDisplayEvent
  | { type: 'approval-requested'; approval: ApprovalView }
  | { type: 'approval-resolved' }
  | { type: 'question-requested'; question: QuestionView }
  | { type: 'question-resolved' }
  | { type: 'hydrate'; messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>; todos?: ChatTodoItem[] }
  | { type: 'context'; labels: Partial<TuiContextLabels> }
  | { type: 'clear' }

const MAX_TOOL_BLOCKS = 30

let nextId = 0
function viewId(): string {
  nextId += 1
  return `v${Date.now().toString(36)}-${nextId}`
}

export function createInitialState(): TuiState {
  return {
    blocks: [],
    thinkingExpanded: false,
    toolsExpanded: false,
    todosExpanded: false,
    todos: [],
    promptTokens: 0,
    completionTokens: 0,
    sessionPromptTokens: 0,
    sessionCompletionTokens: 0,
    status: 'idle',
    statusText: '',
    awaitingApproval: null,
    awaitingQuestion: null,
    modelLabel: '',
    workspaceLabel: '',
    approvalLabel: '',
    conversationLabel: '',
  }
}

/** Append a streamed delta to the trailing block of the same kind, else open one. */
function appendStream(blocks: TimelineBlock[], kind: 'assistant' | 'thinking', delta: string): TimelineBlock[] {
  if (!delta) return blocks
  const last = blocks[blocks.length - 1]
  if (last && last.kind === kind && last.endedAt === undefined) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + delta }]
  }
  return [...blocks, { id: viewId(), kind, text: delta, startedAt: Date.now() }]
}

function closeActive(state: TuiState): TimelineBlock[] {
  return state.blocks.map((block) => block.id === state.activeBlockId && block.endedAt === undefined
    ? { ...block, endedAt: Date.now() } : block)
}

function currentTurnStart(blocks: TimelineBlock[]): number {
  let index = blocks.length - 1
  while (index >= 0 && blocks[index].kind !== 'user') index -= 1
  return index
}

function streamDelta(state: TuiState, kind: 'assistant' | 'thinking', delta: string): TuiState {
  if (!delta) return state
  const active = state.blocks.find((block) => block.id === state.activeBlockId)
  const blocks = appendStream(active?.kind === kind ? state.blocks : closeActive(state), kind, delta)
  return { ...state, blocks, activeBlockId: blocks.at(-1)?.id, status: 'thinking', statusText: kind === 'thinking' ? 'thinking…' : 'writing…' }
}

function upsertToolBlock(
  blocks: TimelineBlock[],
  update: { callId: string; toolName?: string; status?: ToolCardStatus; detail?: string },
): TimelineBlock[] {
  const turnStart = currentTurnStart(blocks)
  const index = blocks.findIndex((item, i) => i >= turnStart && item.kind === 'tool' && item.callId === update.callId)
  let next: TimelineBlock[]
  if (index >= 0) {
    const current = blocks[index]
    next = blocks.map((item, i) => (i === index
      ? {
        ...item,
        toolName: update.toolName ?? current.toolName,
        toolStatus: update.status ?? current.toolStatus,
        toolDetail: update.detail ?? current.toolDetail,
        endedAt: update.status === 'completed' || update.status === 'failed' ? Date.now() : current.endedAt,
      }
      : item))
  } else {
    next = [...blocks, {
      id: viewId(),
      kind: 'tool' as const,
      text: '',
      callId: update.callId,
      toolName: update.toolName,
      toolStatus: update.status ?? 'ready',
      toolDetail: update.detail,
      startedAt: Date.now(),
      endedAt: update.status === 'completed' || update.status === 'failed' ? Date.now() : undefined,
    }]
  }
  // Bound memory on long tool-heavy turns: drop the oldest *finished* cards.
  const toolBlocks = next.filter((item) => item.kind === 'tool')
  if (toolBlocks.length <= MAX_TOOL_BLOCKS) return next
  let drop = toolBlocks.length - MAX_TOOL_BLOCKS
  return next.filter((item) => {
    if (drop > 0 && item.kind === 'tool' && (item.toolStatus === 'completed' || item.toolStatus === 'failed')) {
      drop -= 1
      return false
    }
    return true
  })
}

/** True when the current turn already streamed an assistant block (scan back to the last user block). */
function turnHasAssistantText(blocks: TimelineBlock[]): boolean {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === 'user') return false
    if (blocks[i].kind === 'assistant' && blocks[i].text.trim()) return true
  }
  return false
}

function normalizeToolName(name: string): string {
  // Model-facing names use underscores (workspace_edit) while trace entries
  // carry runtime names (workspace.edit): compare punctuation-insensitively.
  return name.replace(/[._-]+/g, '').toLowerCase()
}

/**
 * Attach post-turn trace previews to tool blocks in stream order: same
 * (normalized) tool name pairs nth-with-nth, leftovers pair by position.
 */
function applyTracePreviews(blocks: TimelineBlock[], traces: TracePreview[]): TimelineBlock[] {
  const remaining = [...traces]
  const turnStart = currentTurnStart(blocks)
  return blocks.map((block, blockIndex) => {
    if (blockIndex < turnStart) return block
    if (block.kind !== 'tool' || block.toolSummary || remaining.length === 0) return block
    const name = normalizeToolName(block.toolName ?? '')
    let index = remaining.findIndex((trace) => normalizeToolName(trace.toolName) === name)
    if (index < 0) index = 0
    const [preview] = remaining.splice(index, 1)
    if (!preview) return block
    return { ...block, toolSummary: preview.summary, toolPreview: preview.diff }
  })
}

function reduceAgentEvent(state: TuiState, event: ChatAgentEvent): TuiState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, status: 'thinking', statusText: 'thinking…' }
    case 'text_delta':
      return streamDelta(state, 'assistant', event.delta ?? '')
    case 'reasoning_delta':
      return streamDelta(state, 'thinking', event.delta ?? '')
    case 'tool_call_start':
      return { ...state, activeBlockId: undefined, statusText: 'preparing tool…',
        blocks: upsertToolBlock(closeActive(state), { callId: event.callId, toolName: event.toolName, status: 'preparing' }) }
    case 'tool_call_delta':
      return { ...state, blocks: state.blocks.map((block, i) => i >= currentTurnStart(state.blocks) && block.kind === 'tool' && block.callId === event.callId
        ? { ...block, argumentChars: (block.argumentChars ?? 0) + event.argumentDeltaLength } : block) }
    case 'tool_call_ready':
      return {
        ...state,
        activeBlockId: undefined,
        statusText: 'preparing tool…',
        blocks: upsertToolBlock(closeActive(state), {
          callId: event.callId,
          toolName: event.toolName,
          status: 'ready',
          detail: event.argumentKeys?.length ? event.argumentKeys.join(', ') : undefined,
        }),
      }
    case 'tool_execution_start':
    case 'tool_execution_update':
      return {
        ...state,
        status: 'thinking',
        statusText: `running ${event.toolName}…`,
        blocks: upsertToolBlock(state.blocks, { callId: event.callId, toolName: event.toolName, status: 'running' }),
      }
    case 'tool_execution_end':
      return {
        ...state,
        blocks: upsertToolBlock(state.blocks, {
          callId: event.callId,
          toolName: event.toolName,
          status: event.status === 'completed' ? 'completed' : 'failed',
        }),
      }
    case 'model_finish':
      return {
        ...state,
        blocks: event.reason === 'length'
          ? [...closeActive(state), { id: viewId(), kind: 'info', text: 'Output truncated: model token limit reached.' }]
          : closeActive(state),
        activeBlockId: undefined,
        statusText: event.reason === 'length' ? 'output truncated (length)' : event.reason === 'tool_calls' ? 'running tools…' : 'finishing…',
      }
    case 'model_error':
      return {
        ...state,
        blocks: [...closeActive(state), { id: viewId(), kind: 'error', text: `model error ${event.code}${event.retryable ? ' (retryable)' : ''}` }],
        activeBlockId: undefined,
        status: 'error',
        statusText: `model error ${event.code}${event.retryable ? ' (retryable)' : ''}`,
      }
    case 'stream_error':
      return { ...state, blocks: [...closeActive(state), { id: viewId(), kind: 'error', text: `stream error: ${event.error}` }],
        activeBlockId: undefined, status: 'error', statusText: `stream error: ${event.error}` }
    case 'stream_end':
      return {
        ...state,
        status: state.status === 'error' ? 'error' : 'idle',
        statusText: event.cancelled ? 'cancelled — history kept' : state.statusText,
      }
    case 'todo_update':
      return { ...state, todos: event.todos.map((todo) => ({ ...todo })) }
    case 'question_requested':
      return {
        ...state,
        statusText: 'awaiting your pick…',
        awaitingQuestion: {
          callId: event.callId,
          questions: event.questions.map((question) => ({
            question: question.question,
            header: question.header,
            multiple: question.multiple,
            options: question.options.map((option) => ({ ...option })),
          })),
          allowCustom: event.allowCustom,
        },
      }
    case 'question_resolved':
      return { ...state, awaitingQuestion: null }
    default:
      return state
  }
}

function pushBlock(state: TuiState, block: Omit<TimelineBlock, 'id'>): TuiState {
  return { ...state, blocks: [...state.blocks, { ...block, id: viewId() }] }
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'turn-start':
      return { ...state, status: 'thinking', statusText: 'thinking…', activeBlockId: undefined,
        turnStartedAt: Date.now(), turnEndedAt: undefined, promptTokens: 0, completionTokens: 0 }
    case 'agent-event':
      return reduceAgentEvent(state, action.event)
    case 'turn-done': {
      // Body text already streamed into timeline blocks; only backfill when
      // the stream carried no assistant text (defensive: stub transports).
      const text = action.assistantText.trim()
      const finalBlocks = closeActive(state).map((block) => block.kind === 'tool' && !block.endedAt
        ? { ...block, toolStatus: 'cancelled' as const, endedAt: Date.now() } : block)
      const blocks = text && !turnHasAssistantText(state.blocks)
        ? [...finalBlocks, { id: viewId(), kind: 'assistant' as const, text: action.assistantText }]
        : finalBlocks
      return {
        ...state,
        blocks,
        status: state.status === 'error' ? 'error' : 'idle',
        activeBlockId: undefined,
        turnEndedAt: Date.now(),
        statusText: action.cancelled ? 'cancelled — history kept' : state.statusText === 'output truncated (length)' ? state.statusText : 'done',
      }
    }
    case 'turn-traces':
      return { ...state, blocks: applyTracePreviews(state.blocks, action.traces) }
    case 'user-message':
      return pushBlock(state, { kind: 'user', text: action.text })
    case 'info':
      return pushBlock(state, { kind: 'info', text: action.text })
    case 'notice':
      return pushBlock(state, { kind: 'notice', text: action.text })
    case 'error':
      return {
        ...state,
        status: 'error',
        statusText: action.text,
        blocks: [...state.blocks, { id: viewId(), kind: 'error', text: action.text }],
      }
    case 'toggle-thinking':
      return { ...state, thinkingExpanded: !state.thinkingExpanded }
    case 'toggle-tools':
      return { ...state, toolsExpanded: !state.toolsExpanded }
    case 'toggle-todos':
      return { ...state, todosExpanded: !state.todosExpanded }
    case 'tool-display':
      return { ...state, blocks: state.blocks.map((block, i) => i >= currentTurnStart(state.blocks) && block.kind === 'tool' && block.callId === action.callId
        ? { ...block, display: { ...block.display, ...action.display },
          toolStatus: action.display.failed ? 'failed' : block.toolStatus } : block) }
    case 'usage':
      return {
        ...state,
        promptTokens: state.promptTokens + action.promptTokens,
        completionTokens: state.completionTokens + action.completionTokens,
        sessionPromptTokens: state.sessionPromptTokens + action.promptTokens,
        sessionCompletionTokens: state.sessionCompletionTokens + action.completionTokens,
      }
    case 'approval-requested':
      return { ...state, awaitingApproval: action.approval }
    case 'approval-resolved':
      return { ...state, awaitingApproval: null }
    case 'question-requested':
      return { ...state, statusText: 'awaiting your pick…', awaitingQuestion: action.question }
    case 'question-resolved':
      return { ...state, awaitingQuestion: null }
    case 'hydrate':
      return {
        ...state,
        blocks: action.messages.map((message) => ({
          id: viewId(),
          kind: (message.role === 'system' ? 'info' : message.role) as TimelineBlock['kind'],
          text: message.text,
        })),
        todos: action.todos ? action.todos.map((todo) => ({ ...todo })) : [],
        status: 'idle',
        statusText: '',
        awaitingApproval: null,
        awaitingQuestion: null,
        activeBlockId: undefined,
        turnStartedAt: undefined,
        turnEndedAt: undefined,
        promptTokens: 0,
        completionTokens: 0,
        sessionPromptTokens: 0,
        sessionCompletionTokens: 0,
      }
    case 'context':
      return { ...state, ...action.labels }
    case 'clear':
      return {
        ...state,
        blocks: [],
        todos: [],
        status: 'idle',
        statusText: '',
        awaitingApproval: null,
        awaitingQuestion: null,
        activeBlockId: undefined,
        turnStartedAt: undefined,
        turnEndedAt: undefined,
        promptTokens: 0,
        completionTokens: 0,
        sessionPromptTokens: 0,
        sessionCompletionTokens: 0,
      }
    default:
      return state
  }
}
