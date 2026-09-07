/**
 * @file Public barrel for @janus-agent/chat-core
 */
export { ChatSessionRuntime, LoadedContextIndex } from './main/llm/chat-session-runtime'
export type { ChatContextBuildOptions } from './main/llm/chat-session-runtime'
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
} from './main/llm/chat-pure'
export type { ChatMessage, ChatRecallInput, KnowledgeSearchPort } from './main/llm/chat-pure'
