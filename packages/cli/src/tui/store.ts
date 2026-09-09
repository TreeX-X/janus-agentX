/**
 * @file Pure TUI state reducer (no Ink, no IO, unit tested).
 * @description Mirrors the §4.3 ChatAgentEvent→UI table shared with the plain
 * loop. JanusX chat cards follow the same transitions on the Electron side.
 */
import type { ChatAgentEvent } from '@janus-agent/chat-core'

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant' | 'info' | 'error' | 'notice'
  text: string
}

export type ToolCardStatus = 'ready' | 'running' | 'completed' | 'failed'

export interface ToolCardView {
  callId: string
  toolName: string
  status: ToolCardStatus
  detail?: string
}

export interface ApprovalView {
  toolName: string
  workspaceId: string
  actionRisk: string
  summary?: string
  paths?: string[]
}

export type TuiStatus = 'idle' | 'thinking' | 'error'

export interface TuiContextLabels {
  modelLabel: string
  workspaceLabel: string
  approvalLabel: string
  conversationLabel: string
}

export interface TuiState extends TuiContextLabels {
  messages: ChatMessageView[]
  pendingText: string
  pendingReasoningChars: number
  toolCards: ToolCardView[]
  status: TuiStatus
  statusText: string
  awaitingApproval: ApprovalView | null
}

export type TuiAction =
  | { type: 'turn-start' }
  | { type: 'agent-event'; event: ChatAgentEvent }
  | { type: 'turn-done'; cancelled: boolean; assistantText: string }
  | { type: 'user-message'; text: string }
  | { type: 'info'; text: string }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'approval-requested'; approval: ApprovalView }
  | { type: 'approval-resolved' }
  | { type: 'hydrate'; messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }> }
  | { type: 'context'; labels: Partial<TuiContextLabels> }
  | { type: 'clear' }

const MAX_CARDS = 30

let nextId = 0
function viewId(): string {
  nextId += 1
  return `v${Date.now().toString(36)}-${nextId}`
}

export function createInitialState(): TuiState {
  return {
    messages: [],
    pendingText: '',
    pendingReasoningChars: 0,
    toolCards: [],
    status: 'idle',
    statusText: '',
    awaitingApproval: null,
    modelLabel: '',
    workspaceLabel: '',
    approvalLabel: '',
    conversationLabel: '',
  }
}

function upsertCard(cards: ToolCardView[], card: ToolCardView): ToolCardView[] {
  const index = cards.findIndex((item) => item.callId === card.callId)
  const next = index >= 0
    ? cards.map((item, i) => (i === index ? { ...item, ...card } : item))
    : [...cards, card]
  return next.slice(-MAX_CARDS)
}

function reduceAgentEvent(state: TuiState, event: ChatAgentEvent): TuiState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, status: 'thinking', statusText: 'thinking…' }
    case 'text_delta':
      return { ...state, pendingText: state.pendingText + (event.delta ?? '') }
    case 'reasoning_delta':
      return { ...state, pendingReasoningChars: state.pendingReasoningChars + (event.delta?.length ?? 0) }
    case 'tool_call_ready':
      return {
        ...state,
        toolCards: upsertCard(state.toolCards, {
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
        toolCards: upsertCard(state.toolCards, { callId: event.callId, toolName: event.toolName, status: 'running' }),
      }
    case 'tool_execution_end':
      return {
        ...state,
        toolCards: upsertCard(state.toolCards, {
          callId: event.callId,
          toolName: event.toolName,
          status: event.status === 'completed' ? 'completed' : 'failed',
        }),
      }
    case 'model_finish':
      return {
        ...state,
        status: 'idle',
        statusText: event.reason === 'length' ? 'output truncated (length)' : '',
      }
    case 'model_error':
      return {
        ...state,
        status: 'error',
        statusText: `model error ${event.code}${event.retryable ? ' (retryable)' : ''}`,
      }
    case 'stream_error':
      return { ...state, status: 'error', statusText: `stream error: ${event.error}` }
    case 'stream_end':
      return {
        ...state,
        status: 'idle',
        statusText: event.cancelled ? 'cancelled — history kept' : state.statusText,
      }
    default:
      return state
  }
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'turn-start':
      return { ...state, status: 'thinking', statusText: 'thinking…', pendingText: '', pendingReasoningChars: 0 }
    case 'agent-event':
      return reduceAgentEvent(state, action.event)
    case 'turn-done': {
      const messages = action.assistantText.trim()
        ? [...state.messages, { id: viewId(), role: 'assistant' as const, text: action.assistantText }]
        : state.messages
      return {
        ...state,
        messages,
        pendingText: '',
        pendingReasoningChars: 0,
        status: action.cancelled ? state.status : 'idle',
        statusText: action.cancelled ? 'cancelled — history kept' : '',
      }
    }
    case 'user-message':
      return { ...state, messages: [...state.messages, { id: viewId(), role: 'user', text: action.text }] }
    case 'info':
      return { ...state, messages: [...state.messages, { id: viewId(), role: 'info', text: action.text }] }
    case 'notice':
      return { ...state, messages: [...state.messages, { id: viewId(), role: 'notice', text: action.text }] }
    case 'error':
      return {
        ...state,
        status: 'error',
        statusText: action.text,
        messages: [...state.messages, { id: viewId(), role: 'error', text: action.text }],
      }
    case 'approval-requested':
      return { ...state, awaitingApproval: action.approval }
    case 'approval-resolved':
      return { ...state, awaitingApproval: null }
    case 'hydrate':
      return {
        ...state,
        messages: action.messages.map((message) => ({
          id: viewId(),
          role: message.role === 'system' ? ('info' as const) : message.role,
          text: message.text,
        })),
        pendingText: '',
        pendingReasoningChars: 0,
        toolCards: [],
        status: 'idle',
        statusText: '',
        awaitingApproval: null,
      }
    case 'context':
      return { ...state, ...action.labels }
    case 'clear':
      return {
        ...state,
        messages: [],
        pendingText: '',
        pendingReasoningChars: 0,
        toolCards: [],
        status: 'idle',
        statusText: '',
        awaitingApproval: null,
      }
    default:
      return state
  }
}
