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
  type AgentStreamEvent,
} from '@janus-agent/agent-core'
import {
  ASK_MAX_CALLS_PER_TURN,
  ChatSessionRuntime,
  buildChatSystemPrompt,
  cloneAskRequest,
  cloneTodos,
  emptyResponseFeedback,
  formatAskHistoryNote,
  formatAskSummary,
  formatTodoStateMessage,
  hasExplicitWorkspaceMutationIntent,
  isContextOverflowError,
  latestUserQuery,
  prepareJanusChatRecall,
  toChatAgentEvent,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
  todoResumePrompt,
  workspaceRecoveryPrompt,
  CHAT_MAX_STEPS,
  TOOL_TRACE_MAX_ENTRIES,
  WORKSPACE_MUTATION_TOOLS,
  type AskUserAnswer,
  type AskUserRequest,
  type ChatAgentEvent,
  type ChatMessage,
  type ChatTodoItem,
  type ChatToolTraceEntry,
  type ChatWorkspaceResource,
  type CompactionSummarizer,
  type KnowledgeRecallTrace,
} from '@janus-agent/chat-core'
import { createTodoLoopTool, createTodoVercelTool, TODOWRITE_TOOL_NAME } from './todo-tool.js'
import { ASKUSER_TOOL_NAME, createAskLoopTool, createAskVercelTool } from './ask-tool.js'
import type { ChatTurnPorts } from '../ports.js'

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
  /**
   * One-shot LLM summarizer for compaction. Absent = deterministic digest
   * pruning only (no extra model call). Failures fall back silently.
   */
  compactionSummarizer?: CompactionSummarizer
}

export interface ChatTurnResult {
  requestId: string
  text: string
  toolTraces: ChatToolTraceEntry[]
  recallTrace?: KnowledgeRecallTrace
  cancelled: boolean
  /** Live todo snapshot for the sticky bar above the composer (empty = hidden). */
  todos: ChatTodoItem[]
  /** True when auto-compaction summarized evicted history during this turn. */
  compacted: boolean
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
  callbacks: {
    onEvent?: (event: ChatAgentEvent) => void
    /** In-process host display adapter; raw events must not be forwarded to IPC. */
    onStreamEvent?: (event: AgentStreamEvent) => void
  } = {},
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const {
    requestId, providerId, sourceTag, conversationId,
    workspaceId, workspacePath, workspaceResources, toolTraces,
  } = request
  const callerId = request.callerId ?? 'janus-agent'
  const onEvent = callbacks.onEvent ?? (() => undefined)
  let streamedText = ''
  let compacted = false
  const executedToolTraces: ChatToolTraceEntry[] = []
  // C2: turn-boundary tracking for the max-turns notice (reset per loop run).
  let turnStarts = 0
  let lastTurnToolResults = 0

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
  // Resolve the per-conversation session first: the todo snapshot below must
  // reflect pre-turn state, and loop-time `todo_write` calls write back here.
  const chatSession = request.chatSession ?? new ChatSessionRuntime()
  const todoStateMessage = formatTodoStateMessage(chatSession.getTodos())
  const todoMessage: ChatMessage | null = todoStateMessage
    ? { role: 'system', content: todoStateMessage }
    : null
  let promptMessages: ChatMessage[]
  if (trustedResources.size > 0) {
    const traceHistory = toolTraceHistoryMessage(
      Array.isArray(toolTraces) ? toolTraces.slice(-TOOL_TRACE_MAX_ENTRIES) : [],
    )
    const allToolManifests = ports.tools.registry.listManifests?.()
      ?? createToolManifests(ports.tools.registry.list())
    // Note: tools sorted + frozen for cache affinity — see .agents/notes/implemented/feature/2026-09-15-context-efficiency.md
    // Registry order is host-dependent; a stable order keeps the system prefix + tool array identical across turns.
    const sortedManifests = [...allToolManifests].sort((left, right) =>
      left.providerName.localeCompare(right.providerName))
    // Offer only what the host runtime implements. The static definition is
    // the cross-repo name contract (all 21 tools), but a host may implement a
    // subset — e.g. the janus CLI has no project.detect. Offering more would
    // let the model call tools that can only fail at execution.
    const implemented = new Set(sortedManifests.map((manifest) => manifest.providerName))
    const offeredTools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: (input) => ports.tools.executeFunctionCall(input, callerId) },
      resources: trustedResources,
      callerId,
      toolManifests: sortedManifests,
    })
    workspaceTools = Object.fromEntries(
      Object.entries(offeredTools).filter(([name]) => implemented.has(name)),
    ) as typeof offeredTools
    const activeToolManifests = Object.freeze(sortedManifests
      .filter((manifest) => Object.hasOwn(workspaceTools ?? {}, manifest.providerName)))
    promptMessages = [
      { role: 'system', content: buildChatSystemPrompt({ resources: trustedResources, toolManifests: activeToolManifests }) },
      ...(traceHistory ? [traceHistory] : []),
      ...(todoMessage ? [todoMessage] : []),
      ...withRecall,
    ]
  } else {
    promptMessages = [
      { role: 'system', content: buildChatSystemPrompt({ resources: trustedResources, toolManifests: [] }) },
      ...(todoMessage ? [todoMessage] : []),
      ...withRecall,
    ]
  }

  if (trustedResources.size > 0 && endpoint.supportsFunctionCalling === false) {
    throw new Error(`Model "${endpoint.modelId}" does not support Function Calling required by attached workspaces`)
  }

  let maxTurns = CHAT_MAX_STEPS
  try {
    maxTurns = await ports.model.getMaxTurns()
  } catch {
    // fall through to default
  }

  const userRequestedMutation = hasExplicitWorkspaceMutationIntent(latestUserQuery(promptMessages))
  let recoveryIssued = false
  // Todo resume nudge is continuous (not one-shot): every no-tool-call round
  // with open items re-injects the prompt. Upper bound is CHAT_MAX_STEPS via
  // maxTurns; a concrete blocker statement is the legitimate exit.
  // One-shot failure-repair nudge: fires once per turn when the loop ends a
  // round without tool calls while fixable tool errors are still unaddressed.
  // Denied/cancelled outcomes are excluded — retrying those burns turns.
  let failureRepairIssued = false
  const modelMessages: JanusAgentMessage[] = promptMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
  // `todo_write` is local and workspace-independent (no approval, no runtime
  // executor): always offered alongside workspace tools, even with none.
  const todoHooks = {
    getTodos: () => chatSession.getTodos(),
    onUpdate: (todos: ChatTodoItem[]) => {
      chatSession.setTodos(todos)
      onEvent({ type: 'todo_update', requestId, todos: cloneTodos(todos) })
    },
  }
  const todoVercelTool = createTodoVercelTool(todoHooks)
  const { execute: _todoExecute, ...todoModelTool } = todoVercelTool
  const todoLoopTool = createTodoLoopTool(todoHooks)
  // `ask_user` is local and workspace-independent like `todo_write`: always
  // offered, even with no workspace. Budget: max calls per turn (hard gate
  // in beforeToolCall so the UI never opens past the limit).
  let askCallsThisTurn = 0
  const askNotes: string[] = []
  const askHooks = {
    question: ports.question,
    onRequest: (askRequest: AskUserRequest, callId: string) => {
      askCallsThisTurn += 1
      onEvent({
        type: 'question_requested',
        requestId,
        callId,
        questions: cloneAskRequest(askRequest).questions.map((question) => ({ ...question })),
        allowCustom: askRequest.allowCustom,
      })
    },
    onResolved: (answer: AskUserAnswer, callId: string) => {
      onEvent({
        type: 'question_resolved',
        requestId,
        callId,
        status: answer.status,
      })
      const note = formatAskHistoryNote(answer)
      if (note) askNotes.push(note)
    },
  }
  const askVercelTool = createAskVercelTool(askHooks)
  const { execute: _askExecute, ...askModelTool } = askVercelTool
  const askLoopTool = createAskLoopTool(askHooks)
  const workspaceModelTools = workspaceTools ? createVercelModelTools(workspaceTools) : {}
  // Stable tool order: sorted workspace tools first, local tools last. The same
  // prefix every round keeps provider prompt-caching effective.
  const sortedWorkspaceModelTools = Object.fromEntries(
    Object.keys(workspaceModelTools).sort((left, right) => left.localeCompare(right))
      .map((name) => [name, workspaceModelTools[name]]),
  )
  const modelTools = { ...sortedWorkspaceModelTools, [TODOWRITE_TOOL_NAME]: todoModelTool, [ASKUSER_TOOL_NAME]: askModelTool }
  const runtimeLoopTools = workspaceTools
    ? createJanusRuntimeToolsForResources(ports.tools, trustedResources, { callerId, preview: createToolPreview })
      .filter((tool) => !!workspaceModelTools[tool.name])
    : []
  // `ask_user` always runs last within its batch: in-flight side effects
  // settle first so the user answers against final state.
  const loopTools = [...runtimeLoopTools, todoLoopTool, askLoopTool]
  for (const tool of loopTools) {
    if (tool.name === ASKUSER_TOOL_NAME) tool.runLast = true
  }

  const loopConfig: Parameters<typeof runJanusAgentLoop>[1] = {
    tools: loopTools,
    stream: createVercelStream({ model: endpoint.model, tools: modelTools, streamTextFn: ports.streamTextFn, ...(endpoint.effort ? { effort: endpoint.effort } : {}) }),
    transformContext: async (context, signal) => {
      // Single-summary compaction absorbs newly evicted turns; the head
      // fingerprint inside skips already-covered content, so repeat calls
      // stay cheap. Never throws: failure keeps deterministic pruning.
      if (request.compactionSummarizer) {
        try {
          if (await chatSession.maybeCompact(context, {
            model: { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
          }, request.compactionSummarizer, signal)) compacted = true
        } catch {
          // Fall through to the deterministic view below.
        }
      }
      return chatSession.buildContext(context, {
        model: { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
      })
    },
    maxTurns,
    steeringPort: request.steeringPort,
    beforeToolCall: async ({ call }) => {
      if (call.name === ASKUSER_TOOL_NAME && askCallsThisTurn >= ASK_MAX_CALLS_PER_TURN) {
        return { block: true, reason: `ask_user budget exhausted (max ${ASK_MAX_CALLS_PER_TURN} calls per turn). Proceed with the answers so far and state assumptions.` }
      }
      return undefined
    },
    afterToolCall: async ({ call, result }) => {
      const runtimeResult = result.details as ToolResult | undefined
      if (runtimeResult?.toolName) {
        chatSession.recordToolResult(runtimeResult)
        executedToolTraces.push(toolTraceEntryFromResult(runtimeResult, requestId))
        return result
      }
      // Local `ask_user` has no runtime ToolResult: record a compact trace
      // so history/resume shows what was confirmed.
      const askDetails = (result.details as { askUser?: AskUserAnswer } | undefined)?.askUser
      if (call.name === ASKUSER_TOOL_NAME && askDetails) {
        executedToolTraces.push({
          toolName: ASKUSER_TOOL_NAME,
          workspaceId: workspaceId ?? '',
          status: askDetails.status === 'answered' ? 'completed' : result.isError ? 'failed' : 'cancelled',
          summary: formatAskSummary(askDetails),
        })
      }
      return result
    },
    getFollowUpMessages: async () => {
      // C2: an aborted turn takes no follow-ups — no recovery prompt, no
      // todo nudge, no extra model round after the user asked to stop.
      if (signal?.aborted) return []
      const followUps: ChatMessage[] = []
      const mutationAttempted = executedToolTraces.some((entry) => WORKSPACE_MUTATION_TOOLS.has(entry.toolName))
      const needsRecovery = !!workspaceTools
        && !recoveryIssued
        && (!streamedText.trim() || (userRequestedMutation && !mutationAttempted))
      if (needsRecovery) {
        recoveryIssued = true
        followUps.push({
          role: 'system',
          content: workspaceRecoveryPrompt(userRequestedMutation && !mutationAttempted),
        })
      }
      // Note: todo list drives continuous execution — see .agents/notes/implemented/feature/2026-09-15-todo-continuous-execution.md
      // Continuous resume nudge: the loop only consults follow-ups on
      // no-tool-call rounds, so each pure-text round with open items costs
      // one more model round until a tool call, a blocker statement, or
      // maxTurns. Closed lists (completed/cancelled only) never nudge.
      const openTodos = chatSession.getTodos().filter(
        (todo) => todo.status === 'pending' || todo.status === 'in_progress',
      )
      if (openTodos.length > 0) {
        followUps.push({ role: 'system', content: todoResumePrompt(openTodos.length) })
      }
      // Note: failure-repair nudge — see .agents/notes/implemented/feature/2026-09-15-context-efficiency.md
      // Tool errors already carry actionable text (C1回灌 + self-heal); without a
      // nudge the model re-reads the 2k error blob and blind-retries the identical
      // call. One explicit repair prompt per turn breaks that loop.
      if (!failureRepairIssued) {
        const fixable = executedToolTraces.filter((entry) =>
          entry.status !== 'completed'
          && entry.status !== 'cancelled'
          && !/denied|cancelled/i.test(`${entry.status} ${entry.summary}`))
        if (fixable.length > 0) {
          failureRepairIssued = true
          const names = [...new Set(fixable.map((entry) => entry.toolName))].slice(0, 4).join(', ')
          followUps.push({
            role: 'system',
            content: `Tool repair (${names}): read the error text in the last tool result, fix the parameters or paths it names, then retry once with a corrected call. Do not repeat the identical failing call. When the error says approval was denied, stop that action and explain instead. When it says timed-out, rerun via background execution and poll.`,
          })
        }
      }
      return followUps
    },
    shouldStopAfterTurn: async ({ messages }) => {
      // C2: stop immediately after abort — the loop top-break covers the
      // next iteration, this covers the tail awaits of the current one.
      if (signal?.aborted) return true
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
      if (loopEvent.type === 'turn_start') turnStarts += 1
      if (loopEvent.type === 'turn_end') lastTurnToolResults = loopEvent.toolResults.length
      const streamEvent = toAgentStreamEvent(requestId, loopEvent)
      if (streamEvent) {
        onEvent(toChatAgentEvent(streamEvent))
        callbacks.onStreamEvent?.(streamEvent)
      }
      if (loopEvent.type === 'message_update') {
        streamedText += loopEvent.delta
      }
    },
  }

  // Provider overflow recovery: one forced compact plus a single retry of the
  // same turn. A second overflow surfaces as the turn error. The retry reuses
  // the initial messages because the loop never mutates its input array.
  // C2: a user abort is a cancellation, not a failure — transports that
  // reject on abort (SDK AbortError) must not surface as "chat turn failed".
  const resetTurnTracking = () => { turnStarts = 0; lastTurnToolResults = 0 }
  try {
    resetTurnTracking()
    await runJanusAgentLoop(modelMessages, loopConfig, signal ?? new AbortController().signal)
  } catch (error) {
    if (signal?.aborted) {
      onEvent({ type: 'stream_end', requestId, cancelled: true })
      return { requestId, text: streamedText, toolTraces: executedToolTraces, recallTrace, cancelled: true, todos: chatSession.getTodos(), compacted }
    }
    if (!isContextOverflowError(error) || !request.compactionSummarizer) throw error
    try {
      if (await chatSession.maybeCompact(
        modelMessages,
        {
          model: { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
          force: true,
        },
        request.compactionSummarizer,
        signal ?? new AbortController().signal,
      )) compacted = true
    } catch {
      // Fall through to the single retry below.
    }
    resetTurnTracking()
    await runJanusAgentLoop(modelMessages, loopConfig, signal ?? new AbortController().signal)
  }

  // C2: max-turns exhaustion is an explicit outcome, not a silent truncation.
  // The loop has no such event, so the turn tracks turn_start/turn_end here;
  // a cap hit with pending tool work tells the user to say 'continue'.
  if (!signal?.aborted && turnStarts >= maxTurns && lastTurnToolResults > 0) {
    const notice = `Stopped after ${maxTurns} turns with tool calls still pending — say 'continue' to resume.`
    onEvent({ type: 'text_delta', requestId, delta: streamedText.trim() ? `\n${notice}` : notice })
    streamedText = streamedText.trim() ? `${streamedText}\n${notice}` : notice
  }

  if (signal?.aborted) {
    onEvent({ type: 'stream_end', requestId, cancelled: true })
    return { requestId, text: streamedText, toolTraces: executedToolTraces, recallTrace, cancelled: true, todos: chatSession.getTodos(), compacted }
  }

  // Persist the confirmed plan into the conversation so switch/resume shows
  // what was chosen (the raw answers JSON already lives in the tool result).
  if (askNotes.length > 0 && !signal?.aborted) {
    const notes = askNotes.join('\n')
    if (streamedText.trim()) {
      if (!streamedText.includes(notes)) {
        streamedText = `${streamedText}\n${notes}`
        onEvent({ type: 'text_delta', requestId, delta: `\n${notes}` })
      }
    } else {
      streamedText = notes
      onEvent({ type: 'text_delta', requestId, delta: notes })
    }
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
  return { requestId, text: streamedText, toolTraces: executedToolTraces, recallTrace, cancelled: false, todos: chatSession.getTodos(), compacted }
}
