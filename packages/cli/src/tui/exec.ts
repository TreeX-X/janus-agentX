/**
 * @file Shared slash-command executor for both TUI hosts (plain + Ink).
 * @description Pure session logic + message strings; hosts only render
 * `stdout`/`stderr` lines and own session replacement. Keeps both loops
 * byte-identical without duplicating command semantics.
 */
import { commandHelpText } from '../commands.js'
import { formatConnectList } from '../connect.js'
import { effortMeta, formatEffortList, resolveEffortArg } from '../effort.js'
import { listProviderModels, type ProviderEntry } from '../providers.js'
import type { ApprovalModeOption } from '../args.js'
import type { ConversationSummary } from '../conversations.js'

/** Structural subset of CliSession used by commands (satisfied by CliSession). */
export interface CommandSession {
  clearHistory(): Promise<void>
  createConversation(title?: string): Promise<ConversationSummary>
  listConversations(): ConversationSummary[]
  switchConversation(ref: string): Promise<ConversationSummary | null>
  renameConversation(ref: string, title: string): Promise<ConversationSummary | null>
  deleteConversation(ref: string): Promise<ConversationSummary | null>
  listModels(): string[]
  getModelId(): string | undefined
  setModel(modelId: string): void
  getEffort(): string
  setEffort(effort: string): void
  listProviders(): { entries: ProviderEntry[]; activeId: string }
  setProvider(ref: string): void
  removeProvider(ref: string): { id: string; removedKey: boolean }
  getProviderId(): string
  hasApiKey(): boolean
  /** Key origin: '/key' | '--api-key' | 'auth.json' | env var name | null. */
  getApiKeySource(): string | null
  /** Key source for any provider id (auth file or env); never key material. */
  keySourceFor(providerId: string): string | null
  getEffectiveBaseUrl(): string
  getConfigPath(): string | null
  /** Effective window for the active provider/model; estimated flags the fallback guess. */
  getContextWindow(): { value: number; estimated: boolean }
  setApiKey(key: string): void
  getWorkspaceRoot(): string
  getApprovalMode(): ApprovalModeOption
  setApprovalMode(mode: ApprovalModeOption): void
  getConversationId(): string
}

export interface RecreateResult {
  ok: boolean
  message: string
}

export interface CommandOutcome {
  stdout: string[]
  stderr: string[]
  exit?: boolean
  /** True when the host replaced the session (workspace switch): reset UI. */
  workspaceSwitched?: boolean
  /** The host should run the /connect wizard with these prefilled args. */
  connect?: { ref?: string; key?: string; baseURL?: string }
}

export function formatConversation(index: number, summary: ConversationSummary): string {
  return `${index + 1}${summary.active ? '*' : ' '} ${summary.title} (${summary.turnCount} turns) [${summary.id.slice(0, 8)}]`
}

function continued(stdout: string[] = [], stderr: string[] = [], extra: Partial<CommandOutcome> = {}): CommandOutcome {
  return { stdout, stderr, ...extra }
}

export async function executeCommand(
  session: CommandSession,
  command: string,
  args: string[],
  host: { recreateWorkspace?: (dir: string) => Promise<RecreateResult> } = {},
): Promise<CommandOutcome> {
  switch (command) {
    case 'help':
      return continued([commandHelpText()])
    case 'key': {
      if (args.length === 0) {
        return continued([`api key: ${session.hasApiKey() ? 'set' : 'missing'} (/key > --api-key > <apiKeyEnv> > JANUS_API_KEY, memory only)`])
      }
      try {
        session.setApiKey(args[0])
      } catch (error) {
        return continued([], [error instanceof Error ? error.message : String(error)])
      }
      return continued(['api key set for this run (memory only, never written to disk). Use /connect to persist per-provider keys.'])
    }
    case 'exit':
      return { stdout: [], stderr: [], exit: true }
    case 'clear':
      await session.clearHistory()
      return continued(['history cleared.'])
    case 'new': {
      const summary = await session.createConversation(args.join(' ') || undefined)
      const index = session.listConversations().findIndex((item) => item.id === summary.id)
      return continued([`new conversation: ${formatConversation(index, summary)}`])
    }
    case 'list': {
      const conversations = session.listConversations()
      return continued([conversations.map((summary, index) => formatConversation(index, summary)).join('\n')])
    }
    case 'switch': {
      if (args.length === 0) return continued([], ['usage: /switch <number|id>'])
      const summary = await session.switchConversation(args[0])
      if (!summary) return continued([], [`no conversation matches: ${args[0]}`])
      const index = session.listConversations().findIndex((item) => item.id === summary.id)
      return continued([`switched to: ${formatConversation(index, summary)}`])
    }
    case 'rename': {
      if (args.length === 0) return continued([], ['usage: /rename <title>'])
      const summary = await session.renameConversation(session.getConversationId(), args.join(' '))
      if (!summary) return continued([], ['janus: rename failed.'])
      return continued([`renamed to: ${summary.title}`])
    }
    case 'delete': {
      const summary = await session.deleteConversation(args[0] ?? session.getConversationId())
      if (!summary) return continued([], [`no conversation matches: ${args[0]}`])
      const index = session.listConversations().findIndex((item) => item.id === summary.id)
      return continued([`deleted. active: ${formatConversation(index, summary)}`])
    }
    case 'model': {
      if (args.length === 0) {
        const models = session.listModels()
        const active = session.getModelId()
        const head = `model: ${active ?? '(no model — set one with /model <id>)'} · effort: ${session.getEffort()}`
        if (models.length === 0) return continued([head])
        return continued([`${head}\n${models.map((model) => `${model === active ? '*' : ' '} ${model}`).join('\n')}`])
      }
      try {
        session.setModel(args[0])
      } catch (error) {
        return continued([], [error instanceof Error ? error.message : String(error)])
      }
      return continued([`model switched: ${args[0]} · effort: ${session.getEffort()}`])
    }
    case 'effort': {
      if (args.length === 0) {
        // Ink (`App.tsx`) and plain (`repl.ts`) intercept the bare form with
        // an interactive picker; this rich list is the fallback for tests
        // and non-interactive hosts.
        return continued([formatEffortList(session.getEffort())])
      }
      const level = resolveEffortArg(args[0] ?? '')
      if (!level) {
        return continued([], [`janus: unknown effort "${args[0]}". Supported: none|minimal|low|medium|high|xhigh|max|ultra or 1-8.`])
      }
      try {
        session.setEffort(level)
      } catch (error) {
        return continued([], [error instanceof Error ? error.message : String(error)])
      }
      const meta = effortMeta(session.getEffort() as Parameters<typeof effortMeta>[0])
      return continued([`effort switched: ${session.getEffort()} — ${meta.hint} (${meta.detail})`])
    }
    case 'workspace': {
      if (args.length === 0) return continued([`workspace: ${session.getWorkspaceRoot()}`])
      if (!host.recreateWorkspace) return continued([], ['janus: workspace switching is unavailable here.'])
      const result = await host.recreateWorkspace(args[0])
      if (!result.ok) return continued([], [result.message])
      return continued([result.message], [], { workspaceSwitched: true })
    }
    case 'provider': {
      const { entries, activeId } = session.listProviders()
      if (args.length === 0) {
        return continued([entries.length === 0
          ? 'providers: (none)'
          : entries.map((entry) => `${entry.id === activeId ? '*' : ' '} ${entry.id}${entry.name ? ` (${entry.name})` : ''} — ${listProviderModels(entry).length} model(s)`).join('\n')])
      }
      const [sub, ...rest] = args
      if ((sub === 'rm' || sub === 'remove' || sub === 'del') && rest.length === 1) {
        try {
          const removed = session.removeProvider(rest[0])
          return continued([`provider removed: ${removed.id}${removed.removedKey ? ' (key cleared from auth.json)' : ''}`])
        } catch (error) {
          return continued([], [error instanceof Error ? error.message : String(error)])
        }
      }
      try {
        session.setProvider(args[0])
      } catch (error) {
        return continued([], [error instanceof Error ? error.message : String(error)])
      }
      return continued([`provider switched: ${session.getProviderId()} · model ${session.getModelId() ?? '(no model)'} · effort ${session.getEffort()}`])
    }
    case 'status': {
      const keySource = session.getApiKeySource()
      const context = session.getContextWindow()
      return continued([
        `provider: ${session.getProviderId()} · model: ${session.getModelId() ?? '(no model)'} · effort: ${session.getEffort()}`,
        `baseURL: ${session.getEffectiveBaseUrl()}`,
        `context: ${context.value} tokens${context.estimated ? ' (estimated — set contextWindow for this provider in config to override)' : ''}`,
        `api key: ${keySource ? `set (via ${keySource})` : 'missing (/connect, /key, --api-key, <apiKeyEnv>, or JANUS_API_KEY)'}`,
        `config: ${session.getConfigPath() ?? '(memory only, no file)'}`,
      ])
    }
    case 'connect': {
      // Bare /connect renders inline; anything else needs host prompts.
      if (args.length === 0) return continued(formatConnectList(session))
      const [ref, key, baseURL] = args
      return continued([], [], { connect: { ref, key, baseURL } })
    }
    case 'approval': {
      if (args.length === 0) {
        const mode = session.getApprovalMode()
        return continued([[
          `approval: ${mode}`,
          '  auto-run — tools run immediately',
          '  per-action — each write/create asks Confirm/Cancel',
          'switch with /approval <mode>',
        ].join('\n')])
      }
      const mode = args[0].toLowerCase()
      if (mode !== 'auto-run' && mode !== 'per-action') return continued([], ['usage: /approval [auto-run|per-action]'])
      session.setApprovalMode(mode as ApprovalModeOption)
      return continued([mode === 'per-action'
        ? 'approval: per-action (each write/create asks Confirm/Cancel)'
        : 'approval: auto-run'])
    }
    default:
      return continued([], [`unknown command: /${command} (type /help)`])
  }
}
