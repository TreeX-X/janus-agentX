/**
 * @file Public barrel for @janus-agent/agent-core
 * @description Re-exports the portable surface. Host-coupled modules
 * (project/command/git tools) are intentionally NOT exported; hosts register
 * them as plugins via ToolRegistry (see main/agent/tools/host-tool-ports).
 */
export { runJanusAgentLoop, AgentSteeringPort } from './main/agent/loop/janus-agent-loop'
export type {
  JanusAgentEvent,
  JanusAgentLoopConfig,
  JanusAgentMessage,
  JanusAgentStreamResult,
  JanusAgentTool,
  JanusAgentToolResult,
  JanusAfterToolCallContext,
  JanusBeforeToolCallContext,
  JanusBeforeToolCallResult,
  JanusShouldStopAfterTurnContext,
  JanusToolCall,
} from './main/agent/loop/janus-agent-loop'
export {
  createLoopToolsFromVercel,
  createVercelModelTools,
  createVercelStream,
  toVercelMessages,
} from './main/agent/loop/vercel-stream-adapter'
export type { StreamTextFn } from './main/agent/loop/vercel-stream-adapter'
export {
  createJanusRuntimeCodingTools,
  createJanusRuntimeReadOnlyTools,
  createJanusRuntimeReadOnlyToolsForResources,
  createJanusRuntimeTools,
  createJanusRuntimeToolsForResources,
} from './main/agent/loop/runtime-tool-adapter'
export type {
  JanusRuntimeAgentTool,
  JanusRuntimeToolHost,
  JanusRuntimeToolPreview,
  JanusRuntimeWorkspaceResource,
} from './main/agent/loop/runtime-tool-adapter'
export { toAgentStreamEvent, ToolCallAccumulator } from './main/agent/stream/index'
export type {
  AgentStreamEvent,
  AgentStreamToolCall,
  AgentStreamToolResult,
  AgentUsage,
  NormalizedProviderError,
} from './main/agent/stream/index'
export { WorkspaceAgentRuntime, createAgentRuntime } from './main/agent/runtime/runtime'
export type { KnowledgeContextResult, KnowledgeRecallTrace } from './shared/knowledge'
export { ToolRegistry } from './main/agent/runtime/registry'
export type { RegisteredTool } from './main/agent/runtime/registry'
export { createToolManifests } from './main/agent/runtime/tool-manifest'
export type { ToolManifest } from './main/agent/runtime/tool-manifest'
export { toolResultToModelValue } from './main/agent/runtime/tool-result'
export {
  createPolicyDecisionRecord,
  evaluateWorkspaceActionPolicy,
  evaluateWorkspaceReadPolicy,
  isSafeCompileCommand,
  isSensitivePath,
  redactHighConfidenceSecrets,
  redactPolicyValue,
  redactWorkingValue,
  sanitizePolicyText,
  settleApprovalDecision,
} from './main/agent/runtime/policy-gate'
export {
  resolveWorkspaceTarget,
  resolveWorkspaceCreationTarget,
  readWorkspaceFile,
} from './main/agent/runtime/path-guard'
export {
  FilePolicyAuditStore,
  MemoryPolicyAuditStore,
  createFilePolicyAuditStore,
  resolveDefaultAuditDir,
} from './main/agent/runtime/policy-audit-store'
export type { PolicyAuditStore } from './main/agent/runtime/policy-audit-store'
export {
  authorizeRendererAction,
  createRendererActionAuthorizer,
} from './main/agent/runtime/renderer-authorization'
export type { RendererActionAuthorizer, RendererActionRequest } from './main/agent/runtime/renderer-authorization'
export {
  registerWorkspaceTools,
  workspaceCreateTool,
  workspaceEditTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceSearchTool,
} from './main/agent/runtime/tools/workspace-tools'
export type { CommandHost, GitHost, HostToolHosts, ProjectHost } from './main/agent/runtime/tools/host-tool-ports'
export {
  createToolPreview,
  createWorkspaceChatTools,
} from './main/agent/chat-tools/workspace-chat-tools'
export type {
  WorkspaceChatRuntime,
  WorkspaceChatToolOptions,
} from './main/agent/chat-tools/workspace-chat-tools'
export { checkpointManager, CheckpointManager } from './main/agent/checkpoint/checkpoint-manager'
export type { CheckpointEngine } from './main/agent/checkpoint/types'
export { janusWorkspaceFs, isTextBuffer } from './main/agent/environment/janus-workspace-fs'
export type { ResolveWorkspaceRoot, RunEventSink, HostIpcEvent } from './main/agent/ports'
export type {
  AgentRuntimeEvent,
  AgentSession,
  ApprovalPreview,
  ApprovalResult,
  CreateAgentSessionInput,
  ExecuteToolInput,
  PolicyAuditQuery,
  PolicyDecisionRecord,
  ToolCall,
  ToolDefinition,
  ToolInputSchema,
  ToolResult,
} from './shared/ipc/agent-runtime'
