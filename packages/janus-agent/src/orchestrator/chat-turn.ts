/**
 * @file Framework-agnostic chat turn orchestration.
 * @description Port of JanusX llm/chat-orchestrator.handleChatStream minus the
 * Electron shell: no event.reply, no module-level abort/session registries,
 * no knowledge singletons. Streaming flows through an onEvent callback and an
 * AbortSignal owned by the caller; 40ms delta batching and window-destroy
 * guards stay in the shell's llm-handlers adapter.
 *
 * Behaviour parity notes (any change here needs a shell-side twin test):
 * - trusted resource validation (<=12, no dup, running session, id match)
 * - knowledge recall only for sourceTag 'janus-chat'
 * - function-calling gate for attached workspaces
 * - recovery follow-up when a mutation was requested but never attempted
 * - empty-response fallback mirrored as a text_delta event
 * - observation capture skipped when aborted
 */
import {
  AgentSteeringPort,
  createJanusRuntimeToolsForResources,
  createToolManifests,
  createToolPreview,
  createVercelModelTools,
  createVercelStream,
  createWorkspaceChatTools,
  runJanusAgentLoop,
  toAgentStreamEvent,
  type JanusAgentMessage,
  type ToolResult,
} from '@janus-agent/agent-core'
import {
  ChatSessionRuntime,
  buildChatSystemPrompt,
  emptyResponseFeedback,
  hasExplicitWorkspaceMutationIntent,
  latestUserQuery,
  prepareJanusChatRecall,
  toChatAgentEvent,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
  workspaceRecoveryPrompt,
  CHAT_MAX_STEPS,
  TOOL_TRACE_MAX_ENTRIES,
  WORKSPACE_MUTATION_TOOLS,
  type ChatAgentEvent,
  type ChatMessage,
  type ChatToolTraceEntry,
  type ChatWorkspaceResource,
  type KnowledgeRecallTrace,
} from '@janus-agent/chat-core'
import type { ChatTurnPorts } from '../ports'

export interface ChatTurnRequest {
  requestId: string
  messages: ChatMessage[]
  providerId: string
  modelId?: string
  sourceTag?: string
  conversationId?: string
  workspaceId?: string
  workspacePath?: string
  workspaceResources?: ChatWorkspaceResource[]
  toolTraces?: ChatToolTraceEntry[]
  callerId?: string
  /** Stable per conversationId; preserves the loaded-file cache across turns. */
  chatSession?: ChatSessionRuntime
  steeringPort?: AgentSteeringPort
}

export interface ChatTurnResult {
  requestId: string
  text: string
  toolTraces: ChatToolTraceEntry[]
  recallTrace?: KnowledgeRecallTrace
  cancelled: boolean
}

interface TrustedResource {
  sessionId: string
  workspaceRoot: string
  workspaceName: string
}

function resolveWorkspaceChatResources(
  resources: ChatWorkspaceResource[] | undefined,
  getSession: ChatTurnPorts['sessions']['getSession'],
): Map<string, TrustedResource> {
  const trusted = new Map<string, TrustedResource>()
  if (!resources) return trusted
  if (!Array.isArray(resources) || resources.length > 12) throw new Error('Invalid attached workspace resources')
  const sessionIds = new Set<string>()
  for (const resource of resources) {
    if (!resource?.workspaceId || !resource.agentSessionId || typeof resource.workspaceName !== 'string') {
      throw new Error('Invalid attached workspace resource')
    }
    if (trusted.has(resource.workspaceId) || sessionIds.has(resource.agentSessionId)) {
      throw new Error('Duplicate attached workspace resource')
    }
    const session = getSession(resource.agentSessionId)
    if (!session || session.status !== 'running' || session.workspaceId !== resource.workspaceId) {
      throw new Error(`Attached workspace session is unavailable: ${resource.workspaceId}`)
    }
    sessionIds.add(resource.agentSessionId)
    trusted.set(resource.workspaceId, {
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      workspaceName: resource.workspaceName.trim().slice(0, 120) || resource.workspaceId,
    })
  }
  return trusted
}

export async function runChatTurn(
  request: ChatTurnRequest,
  ports: ChatTurnPorts,
  callbacks: { onEvent?: (event: ChatAgentEvent) => void } = {},
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const {
    requestId, providerId, sourceTag, conversationId,
    workspaceId, workspacePath, workspaceResources, toolTraces,
  } = request
  const callerId = request.callerId ?? 'janus-agent'
  const onEvent = callbacks.onEvent ?? (() => undefined)
  let streamedText = ''
  const executedToolTraces: ChatToolTraceEntry[] = []

  const endpoint = await ports.model.resolve(providerId, request.modelId)
  if (!endpoint.modelId) throw new Error('No model ID configured')

  const formattedMessages = request.messages
    .filter((m) => m.content && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }))

  const trustedResources = sourceTag === 'janus-chat'
    ? resolveWorkspaceChatResources(workspaceResources, ports.sessions.getSession)
    : new Map<string, TrustedResource>()
  const soleResource = trustedResources.size === 1 ? [...trustedResources.entries()][0] : undefined

  let recallTrace: KnowledgeRecallTrace | undefined
  let withRecall = formattedMessages
  if (sourceTag === 'janus-chat' && ports.knowledgeSearch) {
    const recall = await prepareJanusChatRecall({
      requestId,
      messages: formattedMessages,
      workspaceId: soleResource?.[0] ?? workspaceId,
      workspacePath: soleResource?.[1].workspaceRoot ?? workspacePath,
      search: ports.knowledgeSearch,
    })
    withRecall = recall.messages
    recallTrace = recall.trace
  }

  let workspaceTools: ReturnType<typeof createWorkspaceChatTools> | undefined
  let promptMessages: ChatMessage[]
  if (trustedResources.size > 0) {
    const traceHistory = toolTraceHistoryMessage(
      Array.isArray(toolTraces) ? toolTraces.slice(-TOOL_TRACE_MAX_ENTRIES) : [],
    )
    const allToolManifests = ports.tools.registry.listManifests?.()
      ?? createToolManifests(ports.tools.registry.list())
    workspaceTools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: (input) => ports.tools.executeFunctionCall(input, callerId) },
      resources: trustedResources,
      callerId,
      toolManifests: allToolManifests,
    })
    const activeToolManifests = allToolManifests
      .filter((manifest) => Object.hasOwn(workspaceTools ?? {}, manifest.providerName))
    promptMessages = [
      { role: 'system', content: buildChatSystemPrompt({ resources: trustedResources, toolManifests: activeToolManifests }) },
      ...(traceHistory ? [traceHistory] : []),
      ...withRecall,
    ]
  } else {
    promptMessages = [
      { role: 'system', content: buildChatSystemPrompt({ resources: trustedResources, toolManifests: [] }) },
      ...withRecall,
    ]
  }

  if (trustedResources.size > 0 && endpoint.supportsFunctionCalling === false) {
    throw new Error(`Model "${endpoint.modelId}" does not support Function Calling required by attached workspaces`)
  }

  const chatSession = request.chatSession ?? new ChatSessionRuntime()
  let maxTurns = CHAT_MAX_STEPS
  try {
    maxTurns = await ports.model.getMaxTurns()
  } catch {
    // fall through to default
  }

  const userRequestedMutation = hasExplicitWorkspaceMutationIntent(latestUserQuery(promptMessages))
  let recoveryIssued = false
  const modelMessages: JanusAgentMessage[] = promptMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
  const modelTools = workspaceTools ? createVercelModelTools(workspaceTools) : undefined
  const loopTools = workspaceTools
    ? createJanusRuntimeToolsForResources(ports.tools, trustedResources, { callerId, preview: createToolPreview })
      .filter((tool) => !!modelTools?.[tool.name])
    : []

  await runJanusAgentLoop(modelMessages, {
    tools: loopTools,
    stream: createVercelStream({ model: endpoint.model, tools: modelTools, streamTextFn: ports.streamTextFn }),
    transformContext: async (context) => chatSession.buildContext(context, {
      model: { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
    }),
    maxTurns,
    steeringPort: request.steeringPort,
    afterToolCall: async ({ result }) => {
      const runtimeResult = result.details as ToolResult | undefined
      if (runtimeResult?.toolName) {
        chatSession.recordToolResult(runtimeResult)
        executedToolTraces.push(toolTraceEntryFromResult(runtimeResult, requestId))
      }
      return result
    },
    getFollowUpMessages: async () => {
      const mutationAttempted = executedToolTraces.some((entry) => WORKSPACE_MUTATION_TOOLS.has(entry.toolName))
      const needsRecovery = !!workspaceTools
        && !recoveryIssued
        && (!streamedText.trim() || (userRequestedMutation && !mutationAttempted))
      if (!needsRecovery) return []
      recoveryIssued = true
      return [{
        role: 'system',
        content: workspaceRecoveryPrompt(userRequestedMutation && !mutationAttempted),
      }]
    },
    shouldStopAfterTurn: async ({ messages }) => {
      if (!workspaceTools) return false
      try {
        chatSession.buildContext(messages, {
          model: { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
        })
        return false
      } catch {
        return true
      }
    },
    onEvent: (loopEvent) => {
      if (signal?.aborted) return
      const streamEvent = toAgentStreamEvent(requestId, loopEvent)
      if (streamEvent) onEvent(toChatAgentEvent(streamEvent))
      if (loopEvent.type === 'message_update') {
        streamedText += loopEvent.delta
      }
    },
  }, signal ?? new AbortController().signal)

  if (signal?.aborted) {
    onEvent({ type: 'stream_end', requestId, cancelled: true })
    return { requestId, text: streamedText, toolTraces: executedToolTraces, recallTrace, cancelled: true }
  }

  if (!streamedText.trim()) {
    const feedback = emptyResponseFeedback(executedToolTraces, userRequestedMutation)
    onEvent({ type: 'text_delta', requestId, delta: feedback })
    streamedText = feedback
  }

  const observationTargets = trustedResources.size > 0
    ? [...trustedResources].map(([id, resource]) => ({ workspaceId: id, workspacePath: resource.workspaceRoot, sessionId: resource.sessionId }))
    : workspaceId && workspacePath
      ? [{ workspaceId, workspacePath, sessionId: conversationId ?? requestId }]
      : []
  if (sourceTag === 'janus-chat' && ports.knowledgeCapture && observationTargets.length > 0) {
    const userMessage = [...withRecall].reverse().find((message) => message.role === 'user')
    for (const target of observationTargets) {
      const sessionId = target.sessionId || conversationId || requestId
      await ports.knowledgeCapture.captureTurn({
        targets: [{ workspaceId: target.workspaceId, workspacePath: target.workspacePath, sessionId }],
        userText: userMessage?.content,
        assistantText: streamedText,
        providerId,
        modelId: endpoint.modelId,
        correlationId: requestId,
      })
      await ports.knowledgeCapture.notifySettled?.(target.workspaceId)
    }
  }

  onEvent({ type: 'stream_end', requestId, cancelled: false })
  return { requestId, text: streamedText, toolTraces: executedToolTraces, recallTrace, cancelled: false }
}
