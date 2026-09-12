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
import { streamChatModel } from './model-stream.js'
import { toDisplayEvent, type CliDisplayEvent } from './tool-display.js'
import {
  createAgentRuntime,
  createToolManifests,
  registerWorkspaceTools,
} from '@janus-agent/agent-core'
import { TOOL_TRACE_MAX_ENTRIES } from '@janus-agent/chat-core'
import type { ChatTodoItem } from '@janus-agent/chat-core'
import { runChatTurn, type AskUserPortAnswer, type AskUserPortRequest, type ChatTurnPorts, type ChatTurnResult } from '@janus-agent/janus-agent'
import { createChatModel } from './model.js'
import { FALLBACK_MODEL_LIMITS, resolveModelLimits } from './model-limits.js'
import { saveAuthFile } from './auth.js'
import { JobManager, registerNodeHostTools } from '@janus-agent/node-hosts'
import type { ApprovalModeOption } from './args.js'
import { DEFAULT_EFFORT, normalizeEffort, type EffortLevel } from './effort.js'
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
  formatDidYouMean,
  listProviderModels,
  resolveActiveProvider,
  resolveApiKey,
  resolveProviderRef,
  saveCatalogFile,
  suggestSimilar,
  synthesizeCatalog,
  validateModelId,
  type ProviderCatalog,
  type ProviderEntry,
} from './providers.js'

export const CLI_WORKSPACE_ID = 'cli'
/** Shown when a turn needs the model transport but no key is configured. */
export const MISSING_API_KEY_MESSAGE =
  'janus: missing API key. Pass --api-key <key>, set JANUS_API_KEY, or run /connect (or /key <key>) in this session.'
/** Shown when a turn needs a model but none is configured. */
export const MISSING_MODEL_MESSAGE =
  'janus: missing model. Pass --model <id>, set JANUS_MODEL, or run /model <id> in this session.'
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
  /** Bounded replacement/diff preview for file mutations (already redacted upstream). */
  detail?: string
}

/** Mid-turn confirmation request surfaced to the host question UI. */
export interface QuestionPrompt extends AskUserPortRequest {}

export interface CliSessionConfig {
  workspace: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  /** CodeX parity: --effort override (validated at create). */
  effort?: string
  env?: NodeJS.ProcessEnv
  /** Conversation persistence. Defaults to memory (headless `chat` behavior). */
  store?: ConversationStorePort
  /** Provider catalog. Defaults to a synthesized single endpoint (no file). */
  catalog?: ProviderCatalog
  providerId?: string
  /** Persist provider/model defaults on switch. Null/undefined = skip. */
  configPath?: string | null
  /** Per-provider keys (auth.json). Undefined = none. */
  authKeys?: Record<string, string>
  /** Where auth keys persist on /connect. Null/undefined = memory only. */
  authPath?: string | null
  onAuthError?: (error: unknown) => void
  /** Per-action approval UI. Absent = fail-closed deny. */
  onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  /** Mid-turn confirmation UI (`ask_user`). Absent = non-interactive deny. */
  onQuestion?: (prompt: QuestionPrompt, signal: AbortSignal) => Promise<AskUserPortAnswer>
  onCatalogError?: (error: unknown) => void
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export interface SessionValidationError {
  code: 'bad-workspace' | 'session-open-failed' | 'no-providers' | 'unknown-provider' | 'unknown-model' | 'unknown-effort'
  message: string
}

export interface TurnEventCallbacks {
  onEvent?: (event: { requestId: string; event: unknown }) => void
  onDisplayEvent?: (event: CliDisplayEvent) => void
}

type Runtime = ReturnType<typeof createAgentRuntime>

interface ApprovalRequestShape {
  id: string
  sessionId: string
  workspaceId: string
  correlationId: string
  toolName: string
  actionRisk: unknown
  preview?: { summary?: unknown; paths?: unknown; detail?: unknown }
}

export class CliSession {
  private readonly runtime: Runtime
  private readonly hosts: JobManager
  private readonly sessionId: string
  private readonly ports: ChatTurnPorts
  private readonly registry: ConversationRegistry
  private readonly workspaceRoot: string
  private readonly catalog: ProviderCatalog
  private readonly configPath: string | null
  private readonly onCatalogError?: (error: unknown) => void
  private readonly authKeys: Record<string, string>
  private readonly authPath: string | null
  private readonly onAuthError?: (error: unknown) => void
  private onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  private onQuestion?: (prompt: QuestionPrompt, signal: AbortSignal) => Promise<AskUserPortAnswer>
  private readonly baseUrlOverride?: string
  /** From the --api-key flag (wins over env; /key wins over this). */
  private readonly flagApiKey: string | undefined
  /** From /key for this run (memory only, wins over flag and env). */
  private sessionKey: string | undefined
  private readonly env: NodeJS.ProcessEnv
  /** True when the host injected its own model transport (tests/dev): no key needed. */
  private readonly hasCustomTransport: boolean
  private readonly envModel?: string
  private activeProviderId: string
  private modelOverride?: string
  /** Undefined until a model arrives via flags/env/file-defaults or /model. */
  private modelId: string | undefined
  private approvalMode: ApprovalModeOption
  private approvalSignal: AbortSignal | null = null
  /** From --effort (wins over env; /effort wins over this once set). */
  private effortOverride?: string
  private readonly envEffort?: string
  private effortId: EffortLevel = DEFAULT_EFFORT

  private constructor(init: {
    runtime: Runtime
    hosts: JobManager
    sessionId: string
    ports: ChatTurnPorts
    registry: ConversationRegistry
    workspaceRoot: string
    maxTurns: number
    catalog: ProviderCatalog
    configPath: string | null
    onCatalogError?: (error: unknown) => void
    authKeys: Record<string, string>
    authPath: string | null
    onAuthError?: (error: unknown) => void
    onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
    onQuestion?: (prompt: QuestionPrompt, signal: AbortSignal) => Promise<AskUserPortAnswer>
    baseUrlOverride?: string
    flagApiKey: string | undefined
    sessionKey: string | undefined
    env: NodeJS.ProcessEnv
    hasCustomTransport: boolean
    envModel?: string
    activeProviderId: string
    modelOverride?: string
    modelId: string | undefined
    approvalMode: ApprovalModeOption
    effortOverride?: string
    envEffort?: string
    effortId?: EffortLevel
  }) {
    this.runtime = init.runtime
    this.hosts = init.hosts
    this.sessionId = init.sessionId
    this.ports = init.ports
    this.registry = init.registry
    this.workspaceRoot = init.workspaceRoot
    this.catalog = init.catalog
    this.configPath = init.configPath
    this.onCatalogError = init.onCatalogError
    this.authKeys = init.authKeys
    this.authPath = init.authPath
    this.onAuthError = init.onAuthError
    this.onApproval = init.onApproval
    this.onQuestion = init.onQuestion
    this.attachQuestionPort()
    this.baseUrlOverride = init.baseUrlOverride
    this.flagApiKey = init.flagApiKey
    this.sessionKey = init.sessionKey
    this.env = init.env
    this.hasCustomTransport = init.hasCustomTransport
    this.envModel = init.envModel
    this.activeProviderId = init.activeProviderId
    this.modelOverride = init.modelOverride
    this.modelId = init.modelId
    this.approvalMode = init.approvalMode
    this.effortOverride = init.effortOverride
    this.envEffort = init.envEffort
    this.effortId = init.effortId ?? DEFAULT_EFFORT
    this.attachApprovalListener()
  }

  static async create(config: CliSessionConfig): Promise<CliSession | SessionValidationError> {
    const env = config.env ?? process.env
    // No key is fine here: interactive hosts (tui/repl) enter normally and
    // only fail when a turn actually needs the model transport. Headless
    // `chat` still refuses to run without one (see runChat). Key resolution
    // is per active provider: /key > --api-key > <apiKeyEnv> > JANUS_API_KEY.

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
        const ids = catalog.providers.map((candidate) => candidate.id)
        return { code: 'unknown-provider', message: `janus: unknown provider "${config.providerId}". Available: ${ids.join(', ') || '(none)'}.${formatDidYouMean(suggestSimilar(ids, config.providerId))}` }
      }
      return { code: 'no-providers', message: 'janus: no enabled providers. Add one to ~/.janus/config.json or pass --model <id>.' }
    }
    const modelOverride = config.model
    if (modelOverride && !validateModelId(activeEntry, modelOverride)) {
      const models = listProviderModels(activeEntry)
      return {
        code: 'unknown-model',
        message: `janus: unknown model "${modelOverride}" for provider "${activeEntry.id}". Available: ${models.join(', ') || '(none)'}.${formatDidYouMean(suggestSimilar(models, modelOverride))}`,
      }
    }
    const modelId = modelOverride ?? env.JANUS_MODEL ?? catalog.defaultModel ?? effectiveModelId(activeEntry)
    // CodeX parity: --effort > JANUS_EFFORT > file defaultEffort > provider effort > medium.
    const effortOverride = config.effort
    if (effortOverride && !normalizeEffort(effortOverride)) {
      return {
        code: 'unknown-effort',
        message: `janus: unknown effort "${effortOverride}". Supported: none|minimal|low|medium|high|xhigh|max|ultra.`,
      }
    }
    const envEffort = env.JANUS_EFFORT
    if (envEffort && !normalizeEffort(envEffort)) {
      return {
        code: 'unknown-effort',
        message: `janus: unknown JANUS_EFFORT "${envEffort}". Supported: none|minimal|low|medium|high|xhigh|max|ultra.`,
      }
    }
    const effortId = normalizeEffort(effortOverride)
      ?? normalizeEffort(envEffort)
      ?? normalizeEffort(catalog.defaultEffort)
      ?? normalizeEffort(activeEntry.effort)
      ?? DEFAULT_EFFORT
    // No model is fine here (same policy as the API key): interactive hosts
    // (tui/repl) enter normally and only fail when a turn actually needs the
    // model. Headless `chat` still refuses to run without one (see runChat).
    const approvalMode = config.approvalMode ?? 'auto-run'
    const runtime = createAgentRuntime({
      resolveWorkspaceRoot: async (id) => (id === CLI_WORKSPACE_ID ? workspaceRoot : null),
    })
    registerWorkspaceTools(runtime.registry)
    const hosts = new JobManager()
    registerNodeHostTools(runtime.registry, hosts)
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
    const streamTextFn: ChatTurnPorts['streamTextFn'] = config.streamTextFn
      ?? streamChatModel
    const ports: ChatTurnPorts = {
      model: {
        // Placeholder until a model arrives: sendTurn refuses turns while
        // modelId is undefined, so this resolver is never used unconfigured.
        resolve: async () => ({ model: undefined, modelId: modelId ?? '', supportsFunctionCalling: true, effort: effortId }),
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
      hosts,
      sessionId,
      ports,
      registry,
      workspaceRoot,
      maxTurns,
      catalog,
      configPath: config.configPath ?? null,
      onCatalogError: config.onCatalogError,
      authKeys: config.authKeys ? { ...config.authKeys } : {},
      authPath: config.authPath ?? null,
      onAuthError: config.onAuthError,
      onApproval: config.onApproval,
      onQuestion: config.onQuestion,
      baseUrlOverride: config.baseUrl ?? env.JANUS_BASE_URL,
      flagApiKey: config.apiKey,
      sessionKey: undefined,
      env,
      hasCustomTransport: config.streamTextFn !== undefined,
      envModel: env.JANUS_MODEL,
      activeProviderId: activeEntry.id,
      modelOverride,
      modelId,
      approvalMode,
      effortOverride,
      envEffort,
      effortId,
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
  private resolveEffort(entry: ProviderEntry): EffortLevel {
    return normalizeEffort(this.effortOverride)
      ?? normalizeEffort(this.envEffort)
      ?? normalizeEffort(this.catalog.defaultEffort)
      ?? normalizeEffort(entry.effort)
      ?? DEFAULT_EFFORT
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

  /** Precedence: /key > --api-key > auth.json > <apiKeyEnv> > JANUS_API_KEY. */
  private effectiveKey(): string | undefined {
    if (this.sessionKey) return this.sessionKey
    if (this.flagApiKey) return this.flagApiKey
    try {
      const entry = this.activeEntry()
      if (this.authKeys[entry.id]) return this.authKeys[entry.id]
      return resolveApiKey(this.env, entry).key
    } catch {
      return undefined
    }
  }

  /**
   * Where the effective key came from:
   * '/key' | '--api-key' | 'auth.json' | env var name | null.
   */
  getApiKeySource(): string | null {
    if (this.sessionKey) return '/key'
    if (this.flagApiKey) return '--api-key'
    try {
      const entry = this.activeEntry()
      if (this.authKeys[entry.id]) return 'auth.json'
      return resolveApiKey(this.env, entry).source ?? null
    } catch {
      return null
    }
  }

  /**
   * Key source for any provider id (auth file or env only; the ACTIVE
   * provider may additionally resolve /key or --api-key — see getApiKeySource).
   * Used by /connect and /status lists. Never returns key material.
   */
  keySourceFor(providerId: string): string | null {
    if (this.authKeys[providerId]) return 'auth.json'
    const entry = this.catalog.providers.find((candidate) => candidate.id === providerId)
    if (!entry) return null
    return resolveApiKey(this.env, entry).source ?? null
  }

  getEffectiveBaseUrl(): string {
    return this.baseUrlOverride ?? this.activeEntry().baseURL ?? DEFAULT_BASE_URL
  }

  /** Single precedence chain (config override > built-in table > fallback) shared by create and rebuilds. */
  private resolveLimits(entry: ProviderEntry, modelId: string | undefined) {
    return resolveModelLimits({
      modelId,
      override: { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens },
    })
  }

  private rebuildTransport(): void {
    const entry = this.activeEntry()
    const modelId = this.resolveModelId(entry)
    this.modelId = modelId
    this.effortId = this.resolveEffort(entry)
    // Without a model there is nothing to build yet: sendTurn refuses turns
    // until one arrives, so the placeholder resolver below is never used.
    // (Same policy as a missing API key.)
    if (!modelId) return
    // Without a key there is nothing to build yet: sendTurn refuses turns
    // until one arrives, so the placeholder resolver below is never used.
    // Switching providers re-resolves the env key, so each provider can
    // carry its own <apiKeyEnv> credential.
    const apiKey = this.effectiveKey()
    if (!apiKey) return
    const baseURL = this.getEffectiveBaseUrl()
    const model = createChatModel({ baseURL, apiKey, modelId })
    const previous = this.ports.model
    const effort = this.effortId
    const limits = this.resolveLimits(entry, modelId)
    this.ports.model = {
      resolve: async () => ({
        model,
        modelId,
        supportsFunctionCalling: true,
        effort,
        contextWindow: limits.limits.contextWindow,
        maxOutputTokens: limits.limits.maxOutputTokens,
      }),
      getMaxTurns: () => previous.getMaxTurns(),
    }
  }

  private persistCatalog(): void {
    if (!this.configPath) return
    try {
      // Last state wins: the default pair always describes the active provider,
      // so a restart never pairs provider B with provider A's model.
      this.catalog.defaultProvider = this.activeProviderId
      this.catalog.defaultModel = this.modelId
      this.catalog.defaultEffort = this.effortId
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
            detail: typeof preview?.detail === 'string' && preview.detail ? preview.detail : undefined,
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

  getModelId(): string | undefined {
    return this.modelId
  }

  /**
   * Effective context window for the active provider/model. Unknown ids
   * return the conservative fallback with `estimated: true` so callers
   * (e.g. /status) can say so instead of stating a guess as fact.
   */
  getContextWindow(): { value: number; estimated: boolean } {
    try {
      const resolved = this.resolveLimits(this.activeEntry(), this.modelId)
      return { value: resolved.limits.contextWindow, estimated: resolved.estimated }
    } catch {
      return { value: FALLBACK_MODEL_LIMITS.contextWindow, estimated: true }
    }
  }

  getEffort(): EffortLevel {
    return this.effortId
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

  getAuthPath(): string | null {
    return this.authPath
  }

  /** Live key map snapshot for host session recreation (workspace switch). */
  getAuthKeys(): Record<string, string> {
    return { ...this.authKeys }
  }

  /** Unique-prefix lookup over enabled providers (null when unknown/ambiguous). */
  findProvider(ref: string): ProviderEntry | null {
    return resolveProviderRef(this.catalog, ref)
  }

  /** Binds `ports.question`: absent handler = non-interactive deny (fail-safe). */
  private attachQuestionPort(): void {
    if (!this.onQuestion) {
      delete this.ports.question
      return
    }
    const handler = this.onQuestion
    this.ports.question = {
      askUser: async (request, signal) => {
        try {
          return await handler(request, signal)
        } catch {
          return { status: 'cancelled' }
        }
      },
    }
  }

  getApprovalHandler(): ((prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>) | undefined {
    return this.onApproval
  }

  getQuestionHandler(): ((prompt: QuestionPrompt, signal: AbortSignal) => Promise<AskUserPortAnswer>) | undefined {
    return this.onQuestion
  }

  /** Lets hosts (re)bind the question UI after construction (Ink panel, workspace switch). */
  setQuestionHandler(handler: ((prompt: QuestionPrompt, signal: AbortSignal) => Promise<AskUserPortAnswer>) | undefined): void {
    this.onQuestion = handler
    this.attachQuestionPort()
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

  /** True once a key is available via /key, flags, or provider env. */
  hasApiKey(): boolean {
    const key = this.effectiveKey()
    return key !== undefined && key.length > 0
  }

  /** Runtime key for host session recreation (workspace switch). */
  getApiKey(): string | undefined {
    return this.effectiveKey()
  }

  /**
   * Set the API key for this run (memory only, never written to disk)
   * and rebuild the model transport so queued turns can proceed.
   */
  setApiKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('usage: /key <api-key>')
    this.sessionKey = trimmed
    this.rebuildTransport()
  }

  getTurnCount(): number {
    return this.registry.getActive().data.messages.filter((message) => message.role === 'user').length
  }

  /** Active conversation messages for UI hydration (switch/resume). */
  getActiveMessages(): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    return this.registry.getActive().data.messages.map((message) => ({ ...message }))
  }

  /** Live todo snapshot for the sticky bar above the composer (empty = hidden). */
  getActiveTodos(): ChatTodoItem[] {
    return this.registry.getActive().data.todos.map((todo) => ({ ...todo }))
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
      const models = listProviderModels(entry)
      throw new Error(`janus: unknown model "${modelId}" for provider "${entry.id}". Available: ${models.join(', ') || '(none)'}.${formatDidYouMean(suggestSimilar(models, modelId))}`)
    }
    this.modelOverride = modelId
    this.rebuildTransport()
    this.persistCatalog()
  }

  /** Switch reasoning effort for subsequent turns (CodeX parity). */
  setEffort(effort: string): void {
    const level = normalizeEffort(effort)
    if (!level) throw new Error(`janus: unknown effort "${effort}". Supported: none|minimal|low|medium|high|xhigh|max|ultra.`)
    this.effortOverride = level
    this.rebuildTransport()
    this.persistCatalog()
  }

  /**
   * Persist a provider key to the auth file (and memory). Throws on empty
   * input; never writes key material anywhere except the auth file.
   * Rebuilds the transport when it targets the active provider.
   */
  saveProviderKey(providerId: string, key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('usage: /connect <provider> <key>')
    this.authKeys[providerId] = trimmed
    if (this.authPath) {
      try {
        saveAuthFile(this.authPath, { version: 1, keys: this.authKeys })
      } catch (error) {
        this.onAuthError?.(error)
      }
    }
    if (providerId === this.activeProviderId) this.rebuildTransport()
    this.persistCatalog()
  }

  /**
   * Add a new provider (or replace the entry with the same id) and persist
   * the catalog. The model override is left alone: callers switch explicitly.
   */
  upsertProvider(entry: ProviderEntry): void {
    if (!entry.id.trim()) throw new Error('janus: provider id must not be empty.')
    const index = this.catalog.providers.findIndex((candidate) => candidate.id === entry.id)
    if (index >= 0) this.catalog.providers[index] = entry
    else this.catalog.providers.push(entry)
    this.persistCatalog()
  }

  /**
   * Switch provider; the model override is cleared so the new provider's
   * default chain applies (flags --model still wins at startup creation).
   */
  setProvider(ref: string): void {
    const entry = resolveProviderRef(this.catalog, ref)
    if (!entry) {
      const ids = this.catalog.providers.map((candidate) => candidate.id)
      throw new Error(`janus: unknown provider "${ref}". Available: ${ids.join(', ') || '(none)'}.${formatDidYouMean(suggestSimilar(ids, ref))}`)
    }
    this.activeProviderId = entry.id
    this.modelOverride = undefined
    this.rebuildTransport()
    this.persistCatalog()
  }

  /**
   * Hard-remove a provider: drops the catalog entry and its auth.json key.
   * Refuses the active provider (switch first) so the session never strands
   * itself mid-run. Removing the last provider is allowed — turns then fail
   * with the usual missing-model hint until /connect adds one back.
   */
  removeProvider(ref: string): { id: string; removedKey: boolean } {
    const entry = resolveProviderRef(this.catalog, ref)
    if (!entry) {
      const ids = this.catalog.providers.map((candidate) => candidate.id)
      throw new Error(`janus: unknown provider "${ref}". Available: ${ids.join(', ') || '(none)'}.${formatDidYouMean(suggestSimilar(ids, ref))}`)
    }
    if (entry.id === this.activeProviderId) {
      throw new Error(`janus: cannot remove the active provider "${entry.id}". Switch first (/provider <id>).`)
    }
    this.catalog.providers = this.catalog.providers.filter((candidate) => candidate.id !== entry.id)
    if (this.catalog.defaultProvider === entry.id) delete this.catalog.defaultProvider
    // NOTE: `delete` is true for absent keys too — check first.
    const removedKey = Object.prototype.hasOwnProperty.call(this.authKeys, entry.id)
    if (removedKey) delete this.authKeys[entry.id]
    if (removedKey && this.authPath) {
      try {
        saveAuthFile(this.authPath, { version: 1, keys: this.authKeys })
      } catch (error) {
        this.onAuthError?.(error)
      }
    }
    this.persistCatalog()
    return { id: entry.id, removedKey }
  }

  setApprovalMode(mode: ApprovalModeOption): void {
    this.approvalMode = mode
    this.runtime.setApprovalMode(this.sessionId, mode)
  }

  async clearHistory(): Promise<void> {
    await this.registry.resetActive()
  }

  /**
   * TUI launch: start a new empty conversation and drop previous ones, so
   * every restart begins fresh instead of resuming the last conversation.
   */
  async startFreshConversation(): Promise<void> {
    await this.registry.freshStart()
  }

  async sendTurn(
    prompt: string,
    callbacks: TurnEventCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatTurnResult> {
    const modelId = this.modelId
    if (!modelId) {
      throw new Error(MISSING_MODEL_MESSAGE)
    }
    if (!this.hasApiKey() && !this.hasCustomTransport) {
      throw new Error(MISSING_API_KEY_MESSAGE)
    }
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
          modelId,
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
        {
          onEvent: (event) => callbacks.onEvent?.({ requestId, event }),
          onStreamEvent: (event) => {
            if (!callbacks.onDisplayEvent) return
            const display = toDisplayEvent(event)
            if (display) callbacks.onDisplayEvent(display)
          },
        },
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
      // Todo snapshot is authoritative from the turn (live-written into the
      // per-conversation ChatSessionRuntime during the loop). Persist it so
      // switch/resume restores the sticky bar; abort keeps partial progress.
      record.data.todos = [...result.todos]
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
    await this.hosts.dispose()
    await this.runtime.cancelSession(this.sessionId).catch(() => undefined)
  }
}

export function isSessionValidationError(value: CliSession | SessionValidationError): value is SessionValidationError {
  return value instanceof CliSession === false && typeof (value as SessionValidationError).code === 'string'
}
