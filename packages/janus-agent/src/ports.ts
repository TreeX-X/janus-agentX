/**
 * @file Host ports for @janus-agent/janus-agent orchestration.
 * @description Framework-agnostic seams. JanusX shell implements these with
 * LlmService / workspaceAgentRuntime / knowledge services / Electron IPC;
 * the janus CLI implements them with local transports and stdout.
 */
import type { ExecuteToolInput, ToolDefinition, ToolManifest, ToolResult } from '@janus-agent/agent-core'

/** Resolved model endpoint (opaque handle + capability flags for gating). */
export interface ModelEndpoint {
  /** Opaque model handle passed straight to the injected streamTextFn. */
  model: unknown
  modelId: string
  supportsFunctionCalling?: boolean
  contextWindow?: number
  maxOutputTokens?: number
}

export interface ModelResolverPort {
  resolve(providerId: string, modelId?: string): Promise<ModelEndpoint>
  /** Shell: configService.getAgentMaxSteps() (default 40). CLI: flag or 40. */
  getMaxTurns(): Promise<number> | number
}

/** Host-owned agent session backing one attached workspace resource. */
export interface AgentSessionDescriptor {
  sessionId: string
  workspaceId: string
  workspaceRoot: string
  status: string
}

export interface SessionResolverPort {
  getSession(agentSessionId: string): AgentSessionDescriptor | null
}

export interface ToolExecutorPort {
  executeFunctionCall(input: ExecuteToolInput, callerId: string): Promise<ToolResult>
  registry: {
    list(): ToolDefinition[]
    listManifests?(): ToolManifest[]
  }
}

export interface ObservationTarget {
  workspaceId: string
  workspacePath: string
  sessionId: string
}

export interface TurnCapture {
  targets: ObservationTarget[]
  userText?: string
  assistantText: string
  providerId: string
  modelId: string
  correlationId: string
}

export interface KnowledgeCapturePort {
  /** Shell: observation-service.capture x2 (user + assistant). Skipped on abort. */
  captureTurn(capture: TurnCapture): Promise<void>
  /** Shell: processing-queue.scheduleImmediate. CLI: no-op. */
  notifySettled?(workspaceId: string): Promise<void>
}

export interface ChatTurnPorts {
  model: ModelResolverPort
  sessions: SessionResolverPort
  tools: ToolExecutorPort
  streamTextFn: (options: Record<string, unknown>) => Promise<{
    textStream: AsyncIterable<string>
    fullStream?: AsyncIterable<{
      type: string
      textDelta?: string
      delta?: string
      toolCallId?: string
      toolName?: string
      argsTextDelta?: string
      args?: unknown
      finishReason?: unknown
      usage?: { promptTokens?: number; completionTokens?: number }
      error?: unknown
    }>
    toolCalls?: Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>>
  }>
  knowledgeSearch?: (input: {
    query: string
    workspaceId?: string
    workspacePath?: string
    maxItems: number
    maxChars: number
  }) => Promise<import('@janus-agent/chat-core').KnowledgeContextResult>
  knowledgeCapture?: KnowledgeCapturePort
}
