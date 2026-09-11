/**
 * @file Public barrel for @janus-agent/chat-core
 */
export { ChatSessionRuntime, LoadedContextIndex } from './main/llm/chat-session-runtime'
export type { ChatContextBuildOptions } from './main/llm/chat-session-runtime'
export {
  TODOWRITE_TOOL_DESCRIPTION,
  TODOWRITE_TOOL_NAME,
  TODO_MAX_CONTENT_CHARS,
  TODO_MAX_ITEMS,
  cloneTodos,
  formatTodoStateMessage,
  hasOpenTodos,
  summarizeTodos,
  validateTodoList,
} from './main/llm/chat-todo'
export type { ChatTodoItem, ChatTodoStatus, TodoSummary } from './main/llm/chat-todo'
export {
  ASKUSER_GUIDANCE,
  ASKUSER_TOOL_DESCRIPTION,
  ASKUSER_TOOL_NAME,
  ASK_MAX_CALLS_PER_TURN,
  ASK_MAX_CUSTOM_CHARS,
  ASK_MAX_DESCRIPTION_CHARS,
  ASK_MAX_HEADER_CHARS,
  ASK_MAX_LABEL_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ASK_MAX_QUESTION_CHARS,
  ASK_MAX_RESULT_CHARS,
  ASK_MIN_OPTIONS,
  askCancelledContent,
  cloneAskRequest,
  formatAskHistoryNote,
  formatAskResultContent,
  formatAskSummary,
  validateAskUserRequest,
} from './main/llm/chat-ask'
export type {
  AskUserAnswer,
  AskUserAnswerItem,
  AskUserOption,
  AskUserQuestion,
  AskUserRequest,
} from './main/llm/chat-ask'
export { toChatAgentEvent } from './main/llm/chat-agent-events'
export { buildChatSystemPrompt } from './main/llm/system-prompt-builder'
export type { SystemPromptBuilderInput } from './main/llm/system-prompt-builder'
export {
  emptyResponseFeedback,
  hasExplicitWorkspaceMutationIntent,
  injectKnowledgeContext,
  latestUserQuery,
  prepareJanusChatRecall,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
  traceFromResult,
  workspaceRecoveryPrompt,
  CHAT_MAX_STEPS,
  TOOL_TRACE_MAX_ENTRIES,
  WORKSPACE_MUTATION_TOOLS,
} from './main/llm/chat-pure'
export type { ChatMessage, ChatRecallInput, KnowledgeSearchPort } from './main/llm/chat-pure'
export type {
  ChatAgentEvent,
  ChatAskOption,
  ChatAskQuestion,
  ChatTodoItem as ChatTodoIpcItem,
  ChatTodoStatus as ChatTodoIpcStatus,
  ChatToolTraceEntry,
  ChatWorkspaceResource,
} from './shared/ipc/llm'
export type { KnowledgeContextResult, KnowledgeRecallTrace } from './shared/knowledge'
