/**
 * @file Resident session over the janus-agent dialogue/tool-call loop.
 * @description Owns one `WorkspaceAgentRuntime` + one agent session + the
 * shared model transport, plus a `ConversationRegistry` holding per-
 * conversation `messages / toolTraces / ChatSessionRuntime`. Both `chat`
 * (single turn) and `tui` (many turns, many conversations) share the same
 * ports assembly. Pure logic + injected IO: no Ink, no stdout.
 *
 * Providers mirror JanusX `ProviderSettings` shapes (see providers.ts);
 * approval resolves through the runtime `approval-requested` event with the
 * same callerId the loop executes tools under (`janus-agent`).
 */
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { streamText } from 'ai'
import {
  createAgentRuntime,
  createToolManifests,
  registerWorkspaceTools,
} from '@janus-agent/agent-core'
import { TOOL_TRACE_MAX_ENTRIES } from '@janus-agent/chat-core'
import { runChatTurn, type ChatTurnPorts, type ChatTurnResult } from '@janus-agent/janus-agent'
import { createChatModel } from './model.js'
import type { ApprovalModeOption } from './args.js'
import {
  ConversationRegistry,
  DEFAULT_CONVERSATION_TITLE,
  memoryConversationStore,
  titleFromPrompt,
  type ConversationStorePort,
  type ConversationSummary,
} from './conversations.js'
import {
  effectiveModelId,
  listProviderModels,
  resolveActiveProvider,
  resolveProviderRef,
  saveCatalogFile,
  synthesizeCatalog,
  validateModelId,
  type ProviderCatalog,
  type ProviderEntry,
} from './providers.js'

export const CLI_WORKSPACE_ID = 'cli'
/** Must match the callerId `runChatTurn` executes tools under (request.callerId ?? 'janus-agent'). */
export const APPROVAL_CALLER_ID = 'janus-agent'
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MAX_TURNS = 40

export interface ApprovalPrompt {
  toolName: string
  workspaceId: string
  actionRisk: string
  summary?: string
  paths?: string[]
}

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
  /** Conversation persistence. Defaults to memory (headless `chat` behavior). */
  store?: ConversationStorePort
  /** Provider catalog. Defaults to a synthesized single endpoint (no file). */
  catalog?: ProviderCatalog
  providerId?: string
  /** Persist provider/model defaults on switch. Null/undefined = skip. */
  configPath?: string | null
  /** Per-action approval UI. Absent = fail-closed deny. */
  onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  onCatalogError?: (error: unknown) => void
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export interface SessionValidationError {
  code: 'missing-model' | 'missing-api-key' | 'bad-workspace' | 'session-open-failed' | 'no-providers' | 'unknown-provider' | 'unknown-model'
  message: string
}

export interface TurnEventCallbacks {
  onEvent?: (event: { requestId: string; event: unknown }) => void
}

type Runtime = ReturnType<typeof createAgentRuntime>

interface ApprovalRequestShape {
  id: string
  sessionId: string
  workspaceId: string
  correlationId: string
  toolName: string
  actionRisk: unknown
  preview?: { summary?: unknown; paths?: unknown }
}

export class CliSession {
  private readonly runtime: Runtime
  private readonly sessionId: string
  private readonly ports: ChatTurnPorts
  private readonly registry: ConversationRegistry
  private readonly workspaceRoot: string
  private readonly catalog: ProviderCatalog
  private readonly configPath: string | null
  private readonly onCatalogError?: (error: unknown) => void
  private onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  private readonly baseUrlOverride?: string
  private readonly apiKey: string
  private readonly envModel?: string
  private activeProviderId: string
  private modelOverride?: string
  private modelId: string
  private approvalMode: ApprovalModeOption
  private approvalSignal: AbortSignal | null = null

  private constructor(init: {
    runtime: Runtime
    sessionId: string
    ports: ChatTurnPorts
    registry: ConversationRegistry
    workspaceRoot: string
    maxTurns: number
    catalog: ProviderCatalog
    configPath: string | null
    onCatalogError?: (error: unknown) => void
    onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
    baseUrlOverride?: string
    apiKey: string
    envModel?: string
    activeProviderId: string
    modelOverride?: string
    modelId: string
    approvalMode: ApprovalModeOption
  }) {
    this.runtime = init.runtime
    this.sessionId = init.sessionId
    this.ports = init.ports
    this.registry = init.registry
    this.workspaceRoot = init.workspaceRoot
    this.catalog = init.catalog
    this.configPath = init.configPath
    this.onCatalogError = init.onCatalogError
    this.onApproval = init.onApproval
    this.baseUrlOverride = init.baseUrlOverride
    this.apiKey = init.apiKey
    this.envModel = init.envModel
    this.activeProviderId = init.activeProviderId
    this.modelOverride = init.modelOverride
    this.modelId = init.modelId
    this.approvalMode = init.approvalMode
    this.attachApprovalListener()
  }

  static async create(config: CliSessionConfig): Promise<CliSession | SessionValidationError> {
    const env = config.env ?? process.env
    const apiKey = config.apiKey ?? env.JANUS_API_KEY
    if (!apiKey) {
      return { code: 'missing-api-key', message: 'janus: missing API key. Pass --api-key <key> or set JANUS_API_KEY.' }
    }

    const workspaceRoot = resolve(config.workspace)
    try {
      if (!statSync(workspaceRoot).isDirectory()) throw new Error('not a directory')
    } catch {
      return { code: 'bad-workspace', message: `janus: workspace is not a directory: ${config.workspace}` }
    }

    const catalog = config.catalog ?? synthesizeCatalog({ model: config.model, baseUrl: config.baseUrl })
    const activeEntry = resolveActiveProvider(catalog, config.providerId)
    if (!activeEntry) {
      if (config.providerId) {
        const ids = catalog.providers.map((candidate) => candidate.id).join(', ') || '(none)'
        return { code: 'unknown-provider', message: `janus: unknown provider "${config.providerId}". Available: ${ids}.` }
      }
      return { code: 'no-providers', message: 'janus: no enabled providers. Add one to ~/.janus/config.json or pass --model <id>.' }
    }
    const modelOverride = config.model
    if (modelOverride && !validateModelId(activeEntry, modelOverride)) {
      return {
        code: 'unknown-model',
        message: `janus: unknown model "${modelOverride}" for provider "${activeEntry.id}". Available: ${listProviderModels(activeEntry).join(', ') || '(none)'}.`,
      }
    }
    const modelId = modelOverride ?? env.JANUS_MODEL ?? catalog.defaultModel ?? effectiveModelId(activeEntry)
    if (!modelId) {
      return { code: 'missing-model', message: 'janus: missing model. Pass --model <id> or set JANUS_MODEL.' }
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

    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS
    type StreamResult = Awaited<ReturnType<ChatTurnPorts['streamTextFn']>>
    const streamTextFn: ChatTurnPorts['streamTextFn'] = config.streamTextFn
      ?? ((opts) => streamText(opts as Parameters<typeof streamText>[0]) as unknown as Promise<StreamResult>)
    const ports: ChatTurnPorts = {
      model: {
        resolve: async () => ({ model: undefined, modelId, supportsFunctionCalling: true }),
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

    const registry = await ConversationRegistry.load(
      config.store ?? memoryConversationStore(),
      config.conversationId,
    )
    const session = new CliSession({
      runtime,
      sessionId,
      ports,
      registry,
      workspaceRoot,
      maxTurns,
      catalog,
      configPath: config.configPath ?? null,
      onCatalogError: config.onCatalogError,
      onApproval: config.onApproval,
      baseUrlOverride: config.baseUrl ?? env.JANUS_BASE_URL,
      apiKey,
      envModel: env.JANUS_MODEL,
      activeProviderId: activeEntry.id,
      modelOverride,
      modelId,
      approvalMode,
    })
    session.rebuildTransport()
    return session
  }

  private activeEntry(): ProviderEntry {
    const entry = this.catalog.providers.find((candidate) => candidate.id === this.activeProviderId)
    if (!entry) throw new Error(`janus: provider "${this.activeProviderId}" is no longer available`)
    return entry
  }

  /** Single precedence chain (flags > env > file > provider) shared by create and rebuilds. */
  private resolveModelId(entry: ProviderEntry): string | undefined {
    if (this.modelOverride) return this.modelOverride
    if (this.envModel) return this.envModel
    // The file defaultModel pairs with the file defaultProvider; other
    // providers fall through to their own default chain.
    if (!this.catalog.defaultProvider || this.catalog.defaultProvider === entry.id) {
      return this.catalog.defaultModel ?? effectiveModelId(entry)
    }
    return effectiveModelId(entry)
  }

  private rebuildTransport(): void {
    const entry = this.activeEntry()
    const modelId = this.resolveModelId(entry)
    if (!modelId) throw new Error(`janus: provider "${entry.id}" has no model configured`)
    const baseURL = this.baseUrlOverride ?? entry.baseURL ?? DEFAULT_BASE_URL
    const model = createChatModel({ baseURL, apiKey: this.apiKey, modelId })
    const previous = this.ports.model
    this.ports.model = {
      resolve: async () => ({ model, modelId, supportsFunctionCalling: true }),
      getMaxTurns: () => previous.getMaxTurns(),
    }
    this.modelId = modelId
  }

  private persistCatalog(): void {
    if (!this.configPath) return
    try {
      // Last state wins: the default pair always describes the active provider,
      // so a restart never pairs provider B with provider A's model.
      this.catalog.defaultProvider = this.activeProviderId
      this.catalog.defaultModel = this.modelId
      saveCatalogFile(this.configPath, this.catalog)
    } catch (error) {
      this.onCatalogError?.(error)
    }
  }

  private attachApprovalListener(): void {
    this.runtime.onEvent((event) => {
      const typed = event as { type?: string; request?: Partial<ApprovalRequestShape> }
      if (typed.type !== 'approval-requested') return
      const request = typed.request
      if (!request || request.sessionId !== this.sessionId || typeof request.id !== 'string') return
      const snapshot: ApprovalRequestShape = {
        id: request.id,
        sessionId: request.sessionId,
        workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : '',
        correlationId: typeof request.correlationId === 'string' ? request.correlationId : '',
        toolName: typeof request.toolName === 'string' ? request.toolName : 'tool',
        actionRisk: request.actionRisk,
        preview: request.preview,
      }
      void (async () => {
        let approved = false
        try {
          const preview = snapshot.preview
          approved = await (this.onApproval?.({
            toolName: snapshot.toolName,
            workspaceId: snapshot.workspaceId,
            actionRisk: typeof snapshot.actionRisk === 'string' ? snapshot.actionRisk : 'unknown',
            summary: typeof preview?.summary === 'string' ? preview.summary : undefined,
            paths: Array.isArray(preview?.paths)
              ? (preview.paths as unknown[]).filter((path): path is string => typeof path === 'string')
              : undefined,
          }, this.approvalSignal ?? new AbortController().signal) ?? false)
        } catch {
          approved = false
        }
        this.runtime.resolveApproval({
          approvalId: snapshot.id,
          approved,
          workspaceId: snapshot.workspaceId,
          sessionId: snapshot.sessionId,
          correlationId: snapshot.correlationId,
          toolName: snapshot.toolName,
          actionRisk: snapshot.actionRisk,
        }, APPROVAL_CALLER_ID)
      })()
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

  getProviderId(): string {
    return this.activeProviderId
  }

  getCatalog(): ProviderCatalog {
    return this.catalog
  }

  getConfigPath(): string | null {
    return this.configPath
  }

  getApprovalHandler(): ((prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>) | undefined {
    return this.onApproval
  }

  /** Lets hosts (re)bind the approval UI after construction (Ink gate, workspace switch). */
  setApprovalHandler(handler: ((prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>) | undefined): void {
    this.onApproval = handler
  }

  getCatalogErrorHandler(): ((error: unknown) => void) | undefined {
    return this.onCatalogError
  }

  listProviders(): { entries: ProviderEntry[]; activeId: string } {
    return { entries: this.catalog.providers, activeId: this.activeProviderId }
  }

  listModels(): string[] {
    return listProviderModels(this.activeEntry())
  }

  getConversationId(): string {
    return this.registry.getActiveId()
  }

  getApprovalMode(): ApprovalModeOption {
    return this.approvalMode
  }

  getTurnCount(): number {
    return this.registry.getActive().data.messages.filter((message) => message.role === 'user').length
  }

  /** Active conversation messages for UI hydration (switch/resume). */
  getActiveMessages(): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    return this.registry.getActive().data.messages.map((message) => ({ ...message }))
  }

  getActiveTitle(): string {
    return this.registry.getActive().data.title
  }

  listConversations(): ConversationSummary[] {
    return this.registry.list()
  }

  async createConversation(title?: string): Promise<ConversationSummary> {
    const id = await this.registry.create(title)
    return this.registry.list().find((summary) => summary.id === id) as ConversationSummary
  }

  async switchConversation(ref: string): Promise<ConversationSummary | null> {
    return this.registry.switch(ref)
  }

  async renameConversation(ref: string, title: string): Promise<ConversationSummary | null> {
    return this.registry.rename(ref, title)
  }

  async deleteConversation(ref: string): Promise<ConversationSummary | null> {
    const activeId = await this.registry.delete(ref)
    if (!activeId) return null
    return this.registry.list().find((summary) => summary.id === activeId) ?? null
  }

  /** Switch model for subsequent turns (rebuilds the local transport handle). */
  setModel(modelId: string): void {
    const entry = this.activeEntry()
    if (!validateModelId(entry, modelId)) {
      throw new Error(`janus: unknown model "${modelId}" for provider "${entry.id}". Available: ${listProviderModels(entry).join(', ') || '(none)'}.`)
    }
    this.modelOverride = modelId
    this.rebuildTransport()
    this.persistCatalog()
  }

  /**
   * Switch provider; the model override is cleared so the new provider's
   * default chain applies (flags --model still wins at startup creation).
   */
  setProvider(ref: string): void {
    const entry = resolveProviderRef(this.catalog, ref)
    if (!entry) {
      const ids = this.catalog.providers.map((candidate) => candidate.id).join(', ') || '(none)'
      throw new Error(`janus: unknown provider "${ref}". Available: ${ids}.`)
    }
    this.activeProviderId = entry.id
    this.modelOverride = undefined
    this.rebuildTransport()
    this.persistCatalog()
  }

  setApprovalMode(mode: ApprovalModeOption): void {
    this.approvalMode = mode
    this.runtime.setApprovalMode(this.sessionId, mode)
  }

  async clearHistory(): Promise<void> {
    await this.registry.resetActive()
  }

  async sendTurn(
    prompt: string,
    callbacks: TurnEventCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatTurnResult> {
    const requestId = randomUUID()
    const record = this.registry.getActive()
    const userMessage = { role: 'user' as const, content: prompt }
    const requestMessages = [...record.data.messages, userMessage]
    if (record.data.title === DEFAULT_CONVERSATION_TITLE) {
      record.data.title = titleFromPrompt(prompt)
    }
    this.approvalSignal = signal ?? new AbortController().signal
    try {
      const result = await runChatTurn(
        {
          requestId,
          messages: requestMessages,
          providerId: 'cli',
          modelId: this.modelId,
          sourceTag: 'janus-chat',
          conversationId: record.data.id,
          workspaceId: CLI_WORKSPACE_ID,
          workspacePath: this.workspaceRoot,
          workspaceResources: [{
            workspaceId: CLI_WORKSPACE_ID,
            workspacePath: this.workspaceRoot,
            workspaceName: this.getWorkspaceName(),
            agentSessionId: this.sessionId,
          }],
          toolTraces: record.data.toolTraces,
          chatSession: record.chatSession,
        },
        this.ports,
        { onEvent: (event) => callbacks.onEvent?.({ requestId, event }) },
        this.approvalSignal,
      )
      if (!result.cancelled) {
        record.data.messages = [...requestMessages, { role: 'assistant' as const, content: result.text }]
        record.data.toolTraces = [...record.data.toolTraces, ...result.toolTraces].slice(-TOOL_TRACE_MAX_ENTRIES)
      } else {
        // Aborted turn: keep the user prompt so the user can retry or move on,
        // but do not record a partial assistant message.
        record.data.messages = requestMessages
      }
      await this.registry.persist(record.data.id)
      return result
    } finally {
      this.approvalSignal = null
    }
  }

  async close(): Promise<void> {
    try {
      await this.registry.persist(this.registry.getActiveId())
    } catch {
      // Best effort: session teardown must not fail.
    }
    await this.runtime.cancelSession(this.sessionId).catch(() => undefined)
  }
}

export function isSessionValidationError(value: CliSession | SessionValidationError): value is SessionValidationError {
  return value instanceof CliSession === false && typeof (value as SessionValidationError).code === 'string'
}
