/**
 * @file Resident session over the janus-agent dialogue/tool-call loop.
 * @description Owns one `WorkspaceAgentRuntime` + one agent session + the
 * accumulated `messages / toolTraces / ChatSessionRuntime` for a
 * conversationId, so both `chat` (single turn) and `tui` (many turns) share
 * the same ports assembly. Pure logic + injected IO: no Ink, no stdout.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { streamText } from 'ai'
import {
  createAgentRuntime,
  createToolManifests,
  registerWorkspaceTools,
} from '@janus-agent/agent-core'
import {
  ChatSessionRuntime,
  TOOL_TRACE_MAX_ENTRIES,
  type ChatToolTraceEntry,
} from '@janus-agent/chat-core'
import { runChatTurn, type ChatTurnPorts, type ChatTurnResult } from '@janus-agent/janus-agent'
import { createChatModel } from './model.js'
import type { ApprovalModeOption } from './args.js'

export const CLI_WORKSPACE_ID = 'cli'
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MAX_TURNS = 40

export interface CliSessionConfig {
  workspace: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  env?: NodeJS.ProcessEnv
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export interface SessionValidationError {
  code: 'missing-model' | 'missing-api-key' | 'bad-workspace' | 'session-open-failed'
  message: string
}

export interface TurnEventCallbacks {
  onEvent?: (event: { requestId: string; event: unknown }) => void
}

type Runtime = ReturnType<typeof createAgentRuntime>

export class CliSession {
  private readonly runtime: Runtime
  private readonly sessionId: string
  private readonly chatSession = new ChatSessionRuntime()
  private readonly ports: ChatTurnPorts
  private readonly workspaceRoot: string
  private readonly maxTurns: number
  private modelId: string
  private readonly conversationId: string
  private approvalMode: ApprovalModeOption
  private messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []
  private toolTraces: ChatToolTraceEntry[] = []

  private constructor(init: {
    runtime: Runtime
    sessionId: string
    ports: ChatTurnPorts
    workspaceRoot: string
    maxTurns: number
    modelId: string
    conversationId: string
    approvalMode: ApprovalModeOption
  }) {
    this.runtime = init.runtime
    this.sessionId = init.sessionId
    this.ports = init.ports
    this.workspaceRoot = init.workspaceRoot
    this.maxTurns = init.maxTurns
    this.modelId = init.modelId
    this.conversationId = init.conversationId
    this.approvalMode = init.approvalMode
  }

  static async create(config: CliSessionConfig): Promise<CliSession | SessionValidationError> {
    const env = config.env ?? process.env
    const modelId = config.model ?? env.JANUS_MODEL
    const baseURL = config.baseUrl ?? env.JANUS_BASE_URL ?? DEFAULT_BASE_URL
    const apiKey = config.apiKey ?? env.JANUS_API_KEY
    if (!modelId) {
      return { code: 'missing-model', message: 'janus: missing model. Pass --model <id> or set JANUS_MODEL.' }
    }
    if (!apiKey) {
      return { code: 'missing-api-key', message: 'janus: missing API key. Pass --api-key <key> or set JANUS_API_KEY.' }
    }

    const workspaceRoot = resolve(config.workspace)
    try {
      if (!statSync(workspaceRoot).isDirectory()) throw new Error('not a directory')
    } catch {
      return { code: 'bad-workspace', message: `janus: workspace is not a directory: ${config.workspace}` }
    }

    const approvalMode = config.approvalMode ?? 'auto-run'
    const runtime = createAgentRuntime({
      resolveWorkspaceRoot: async (id) => (id === CLI_WORKSPACE_ID ? workspaceRoot : null),
    })
    registerWorkspaceTools(runtime.registry)
    let sessionId: string
    try {
      const session = await runtime.createSession({
        workspaceId: CLI_WORKSPACE_ID,
        workspaceRoot,
        approvalMode,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      })
      sessionId = session.id
    } catch (error) {
      return {
        code: 'session-open-failed',
        message: `janus: failed to open workspace session: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const model = createChatModel({ baseURL, apiKey, modelId })
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS
    type StreamResult = Awaited<ReturnType<ChatTurnPorts['streamTextFn']>>
    const streamTextFn: ChatTurnPorts['streamTextFn'] = config.streamTextFn
      ?? ((opts) => streamText(opts as Parameters<typeof streamText>[0]) as unknown as Promise<StreamResult>)
    const ports: ChatTurnPorts = {
      model: {
        resolve: async () => ({ model, modelId, supportsFunctionCalling: true }),
        getMaxTurns: () => maxTurns,
      },
      sessions: {
        getSession: (id) => {
          if (id !== sessionId) return null
          const current = runtime.getSession(sessionId)
          if (!current || current.status !== 'running') return null
          return {
            sessionId: current.id,
            workspaceId: CLI_WORKSPACE_ID,
            workspaceRoot: current.workspace.workspaceRoot,
            status: current.status,
          }
        },
      },
      tools: {
        executeFunctionCall: (input, callerId) => runtime.executeTool(input, callerId),
        registry: {
          list: () => runtime.registry.list(),
          listManifests: () => createToolManifests(runtime.registry.list()),
        },
      },
      streamTextFn,
    }

    return new CliSession({
      runtime,
      sessionId,
      ports,
      workspaceRoot,
      maxTurns,
      modelId,
      conversationId: config.conversationId ?? randomUUID(),
      approvalMode,
    })
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  getWorkspaceName(): string {
    return basename(this.workspaceRoot) || CLI_WORKSPACE_ID
  }

  getModelId(): string {
    return this.modelId
  }

  getConversationId(): string {
    return this.conversationId
  }

  getApprovalMode(): ApprovalModeOption {
    return this.approvalMode
  }

  getTurnCount(): number {
    return this.messages.filter((message) => message.role === 'user').length
  }

  /** Switch model for subsequent turns (rebuilds the local transport handle). */
  setModel(modelId: string, init: { baseURL: string; apiKey: string }): void {
    const model = createChatModel({ baseURL: init.baseURL, apiKey: init.apiKey, modelId })
    const previous = this.ports.model
    this.ports.model = {
      resolve: async () => ({ model, modelId, supportsFunctionCalling: true }),
      getMaxTurns: () => previous.getMaxTurns(),
    }
    this.modelId = modelId
  }

  setApprovalMode(mode: ApprovalModeOption): void {
    this.approvalMode = mode
  }

  clearHistory(): void {
    this.messages = []
    this.toolTraces = []
  }

  async sendTurn(
    prompt: string,
    callbacks: TurnEventCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatTurnResult> {
    const requestId = randomUUID()
    const userMessage = { role: 'user' as const, content: prompt }
    const requestMessages = [...this.messages, userMessage]
    const result = await runChatTurn(
      {
        requestId,
        messages: requestMessages,
        providerId: 'cli',
        modelId: this.modelId,
        sourceTag: 'janus-chat',
        conversationId: this.conversationId,
        workspaceId: CLI_WORKSPACE_ID,
        workspacePath: this.workspaceRoot,
        workspaceResources: [{
          workspaceId: CLI_WORKSPACE_ID,
          workspacePath: this.workspaceRoot,
          workspaceName: this.getWorkspaceName(),
          agentSessionId: this.sessionId,
        }],
        toolTraces: this.toolTraces,
        chatSession: this.chatSession,
      },
      this.ports,
      { onEvent: (event) => callbacks.onEvent?.({ requestId, event }) },
      signal ?? new AbortController().signal,
    )
    if (!result.cancelled) {
      this.messages = [...requestMessages, { role: 'assistant' as const, content: result.text }]
      this.toolTraces = [...this.toolTraces, ...result.toolTraces].slice(-TOOL_TRACE_MAX_ENTRIES)
    } else {
      // Aborted turn: keep the user prompt so the user can retry or move on,
      // but do not record a partial assistant message.
      this.messages = requestMessages
    }
    return result
  }

  async close(): Promise<void> {
    await this.runtime.cancelSession(this.sessionId).catch(() => undefined)
  }
}

export function isSessionValidationError(value: CliSession | SessionValidationError): value is SessionValidationError {
  return value instanceof CliSession === false && typeof (value as SessionValidationError).code === 'string'
}
