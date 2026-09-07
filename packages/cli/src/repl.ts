/**
 * @file Resident plain-text loop for `janus tui` (M0/M1 `--plain` path).
 * @description Readline over stdin/stdout by default; multi-turn history
 * lives in `CliSession`. All side-effect seams (lines/stdout/stderr/env)
 * are injectable so tests drive turns without a TTY. Ink fullscreen lands
 * in M1 on top of the same session/commands.
 */
import { createInterface } from 'node:readline'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { TuiOptions } from './args.js'
import { CliSession, isSessionValidationError, type ApprovalPrompt } from './session.js'
import { defaultHistoryDir, fileConversationStore, type ConversationStorePort, type ConversationSummary } from './conversations.js'
import { listProviderModels, loadEffectiveCatalog } from './providers.js'
import { commandHelpText, parseInputLine } from './commands.js'
import { renderLogoAscii, renderLogoPlain } from './logo.js'

export interface ReplLineSource {
  next(prompt?: string, opts?: { signal?: AbortSignal }): Promise<string | null>
  close(): void
}

export interface ReplIO {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  env?: NodeJS.ProcessEnv
  lines?: ReplLineSource
  /** Conversation persistence. Defaults to ~/.janus/history (memory in tests via injection). */
  store?: ConversationStorePort
  /** Provider config path. Undefined = default file, null = no file. */
  configPath?: string | null
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export function arrayLineSource(lines: Array<string | null>): ReplLineSource {
  let index = 0
  return {
    next: async () => (index < lines.length ? (lines[index++] as string | null) : null),
    close: () => undefined,
  }
}

/**
 * Line-queued source: a permanent `line` listener buffers rows that arrive
 * while a turn is running (pastes, pipes), so no input is lost between
 * prompts. `close`/EOF resolves pending reads with null (clean exit).
 */
function createReadlineSource(onSigint: () => void): ReplLineSource {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const queued: string[] = []
  interface Waiter {
    resolve: (line: string | null) => void
    signal?: AbortSignal
    onAbort?: () => void
  }
  const waiters: Waiter[] = []
  let closed = false
  const takeWaiter = (): Waiter | undefined => {
    const waiter = waiters.shift()
    if (waiter?.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    return waiter
  }
  rl.on('line', (line) => {
    const waiter = takeWaiter()
    if (waiter) waiter.resolve(line)
    else queued.push(line)
  })
  rl.on('close', () => {
    closed = true
    let waiter: Waiter | undefined
    while ((waiter = takeWaiter())) waiter.resolve(null)
  })
  rl.on('SIGINT', onSigint)
  return {
    next: (prompt = 'you> ', opts?: { signal?: AbortSignal }) => {
      const line = queued.shift()
      if (line !== undefined) return Promise.resolve(line)
      if (closed) return Promise.resolve(null)
      // An already-aborted approval prompt resolves empty (= deny) without consuming input.
      if (opts?.signal?.aborted) return Promise.resolve('')
      rl.setPrompt(prompt)
      rl.prompt()
      return new Promise<string | null>((resolve) => {
        const waiter: Waiter = { resolve, signal: opts?.signal }
        if (opts?.signal) {
          waiter.onAbort = () => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            resolve('')
          }
          opts.signal.addEventListener('abort', waiter.onAbort, { once: true })
        }
        waiters.push(waiter)
      })
    },
    close: () => rl.close(),
  }
}

interface ReplState {
  session: CliSession
  options: TuiOptions
  env: NodeJS.ProcessEnv
  stdout: (text: string) => void
  stderr: (text: string) => void
  store: ConversationStorePort
  lines: ReplLineSource
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

function renderEvent(state: ReplState, event: unknown): void {
  const { stdout, stderr } = state
  const typed = event as { type?: string; delta?: string; toolName?: string; argumentKeys?: string[]; status?: string; code?: string; retryable?: boolean; cancelled?: boolean }
  switch (typed.type) {
    case 'text_delta':
      if (typed.delta) stdout(typed.delta)
      return
    case 'tool_call_ready':
      stdout(`\n◇ ${typed.toolName ?? 'tool'}${typed.argumentKeys?.length ? ` (${typed.argumentKeys.join(', ')})` : ''}`)
      return
    case 'tool_execution_end':
      stdout(` → ${typed.status ?? 'done'}`)
      return
    case 'model_error':
      stderr(`\njanus: model error ${typed.code ?? 'unknown'}${typed.retryable ? ' (retryable)' : ''}`)
      return
    case 'stream_end':
      if (typed.cancelled) stdout('\n■ cancelled — history kept')
      return
    default:
      return
  }
}

async function runTurn(state: ReplState, prompt: string, signal: AbortSignal): Promise<void> {
  state.stdout('janus▸ ')
  try {
    await state.session.sendTurn(
      prompt,
      { onEvent: ({ event }) => renderEvent(state, event) },
      signal,
    )
  } catch (error) {
    state.stderr(`\njanus: chat turn failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  state.stdout('\n')
}

function formatConversation(index: number, summary: ConversationSummary): string {
  return `${index + 1}${summary.active ? '*' : ' '} ${summary.title} (${summary.turnCount} turns) [${summary.id.slice(0, 8)}]`
}

/** Terminal approval UI: single-shot y/N (empty/EOF/abort = deny, fail-closed). */
async function askApproval(
  lines: ReplLineSource,
  stdout: (text: string) => void,
  prompt: ApprovalPrompt,
  signal: AbortSignal,
): Promise<boolean> {
  const paths = prompt.paths?.length ? ` (${prompt.paths.join(', ')})` : ''
  const summary = prompt.summary ? ` — ${prompt.summary}` : ''
  // The question goes through stdout (not the line prompt) so injected
  // line sources in tests and pipes render it identically to a TTY.
  stdout(`◇ approve ${prompt.toolName}[${prompt.workspaceId}] risk=${prompt.actionRisk}${summary}${paths}\nAllow? [y/N] `)
  const answer = await lines.next('', { signal })
  if (answer === null) return false
  return /^(y|yes)$/i.test(answer.trim())
}

async function handleCommand(state: ReplState, command: string, args: string[]): Promise<'continue' | 'exit' | 'recreated'> {
  const { stdout, stderr } = state
  switch (command) {
    case 'help':
      stdout(`${commandHelpText()}\n`)
      return 'continue'
    case 'exit':
      return 'exit'
    case 'clear':
      await state.session.clearHistory()
      stdout('history cleared.\n')
      return 'continue'
    case 'new': {
      const summary = await state.session.createConversation(args.join(' ') || undefined)
      const index = state.session.listConversations().findIndex((item) => item.id === summary.id)
      stdout(`new conversation: ${formatConversation(index, summary)}\n`)
      return 'continue'
    }
    case 'list': {
      const conversations = state.session.listConversations()
      stdout(`${conversations.map((summary, index) => formatConversation(index, summary)).join('\n')}\n`)
      return 'continue'
    }
    case 'switch': {
      if (args.length === 0) {
        stderr('usage: /switch <number|id>\n')
        return 'continue'
      }
      const summary = await state.session.switchConversation(args[0])
      if (!summary) {
        stderr(`no conversation matches: ${args[0]}\n`)
        return 'continue'
      }
      const index = state.session.listConversations().findIndex((item) => item.id === summary.id)
      stdout(`switched to: ${formatConversation(index, summary)}\n`)
      return 'continue'
    }
    case 'rename': {
      if (args.length === 0) {
        stderr('usage: /rename <title>\n')
        return 'continue'
      }
      const summary = await state.session.renameConversation(state.session.getConversationId(), args.join(' '))
      if (!summary) {
        stderr('janus: rename failed.\n')
        return 'continue'
      }
      stdout(`renamed to: ${summary.title}\n`)
      return 'continue'
    }
    case 'delete': {
      const summary = await state.session.deleteConversation(args[0] ?? state.session.getConversationId())
      if (!summary) {
        stderr(`no conversation matches: ${args[0]}\n`)
        return 'continue'
      }
      const index = state.session.listConversations().findIndex((item) => item.id === summary.id)
      stdout(`deleted. active: ${formatConversation(index, summary)}\n`)
      return 'continue'
    }
    case 'model': {
      if (args.length === 0) {
        const models = state.session.listModels()
        const active = state.session.getModelId()
        stdout(`model: ${active}\n${models.map((model) => `${model === active ? '*' : ' '} ${model}`).join('\n')}\n`)
        return 'continue'
      }
      try {
        state.session.setModel(args[0])
      } catch (error) {
        stderr(`${error instanceof Error ? error.message : String(error)}\n`)
        return 'continue'
      }
      stdout(`model switched: ${args[0]}\n`)
      return 'continue'
    }
    case 'workspace': {
      if (args.length === 0) {
        stdout(`workspace: ${state.session.getWorkspaceRoot()}\n`)
        return 'continue'
      }
      const next = await CliSession.create({
        workspace: args[0],
        model: state.session.getModelId(),
        baseUrl: state.options.baseUrl,
        apiKey: state.options.apiKey,
        maxTurns: undefined,
        timeoutMs: state.options.timeoutMs,
        approvalMode: state.session.getApprovalMode(),
        env: state.env,
        store: state.store,
        catalog: state.session.getCatalog(),
        providerId: state.session.getProviderId(),
        configPath: state.session.getConfigPath(),
        onApproval: state.session.getApprovalHandler(),
        onCatalogError: state.session.getCatalogErrorHandler(),
        streamTextFn: state.streamTextFn,
      })
      if (isSessionValidationError(next)) {
        stderr(`${next.message}\n`)
        return 'continue'
      }
      await state.session.close()
      state.session = next
      stdout(`workspace switched: ${next.getWorkspaceRoot()} (history cleared)\n`)
      return 'recreated'
    }
    case 'provider': {
      const { entries, activeId } = state.session.listProviders()
      if (args.length === 0) {
        stdout(entries.length === 0
          ? 'providers: (none)\n'
          : `${entries.map((entry) => `${entry.id === activeId ? '*' : ' '} ${entry.id}${entry.name ? ` (${entry.name})` : ''} — ${listProviderModels(entry).length} model(s)`).join('\n')}\n`)
        return 'continue'
      }
      try {
        state.session.setProvider(args[0])
      } catch (error) {
        stderr(`${error instanceof Error ? error.message : String(error)}\n`)
        return 'continue'
      }
      stdout(`provider switched: ${state.session.getProviderId()} · model ${state.session.getModelId()}\n`)
      return 'continue'
    }
    case 'approval': {
      if (args.length === 0) {
        stdout(`approval: ${state.session.getApprovalMode()}\n`)
        return 'continue'
      }
      const mode = args[0].toLowerCase()
      if (mode !== 'auto-run' && mode !== 'per-action') {
        stderr('usage: /approval [auto-run|per-action]\n')
        return 'continue'
      }
      state.session.setApprovalMode(mode)
      stdout(mode === 'per-action'
        ? 'approval: per-action (each write/create will ask y/N)\n'
        : 'approval: auto-run\n')
      return 'continue'
    }
    default:
      stderr(`unknown command: /${command} (type /help)\n`)
      return 'continue'
  }
}

export async function runRepl(options: TuiOptions, io: ReplIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text))
  const env = io.env ?? process.env
  let historyWarned = false
  const warnOnce = (message: string): void => {
    if (!historyWarned) {
      historyWarned = true
      stderr(message)
    }
  }
  const store = io.store ?? fileConversationStore(defaultHistoryDir(), () => {
    warnOnce('janus: history file unavailable, this run keeps memory only.\n')
  })
  let activeController: AbortController | null = null
  const lines = io.lines ?? createReadlineSource(() => {
    // TTY Ctrl+C: cancel the running turn, stay in the loop.
    // Idle Ctrl+C closes the source so the loop exits cleanly (code 0).
    if (activeController) activeController.abort()
    else lines.close()
  })
  if (!io.lines) {
    // Piped stdin never reaches the rl SIGINT listener; the first Ctrl+C
    // cancels the turn, a second one falls through to default termination.
    process.once('SIGINT', () => {
      if (activeController) activeController.abort()
      else lines.close()
    })
  }
  const catalogInput = loadEffectiveCatalog({
    configPath: io.configPath,
    model: options.model,
    baseUrl: options.baseUrl,
    onError: () => warnOnce('janus: provider config unreadable, using flags/env only.\n'),
  })
  const state: ReplState = {
    session: undefined as unknown as CliSession,
    options,
    env,
    stdout,
    stderr,
    store,
    lines,
    streamTextFn: io.streamTextFn,
  }

  const created = await CliSession.create({
    ...options,
    env,
    store,
    catalog: catalogInput.catalog,
    configPath: catalogInput.configPath,
    onApproval: (prompt, signal) => askApproval(lines, stdout, prompt, signal),
    onCatalogError: () => warnOnce('janus: provider config not writable, switches last this run only.\n'),
    streamTextFn: io.streamTextFn,
  })
  if (isSessionValidationError(created)) {
    stderr(`${created.message}\n`)
    return 2
  }
  state.session = created

  stdout(`${options.plain ? renderLogoPlain() : renderLogoAscii()}\n`)
  const restored = created.listConversations()
  const activeTitle = restored.find((summary) => summary.active)?.title ?? ''
  const providerSegment = created.listProviders().entries.length > 1 ? ` · provider ${created.getProviderId()}` : ''
  stdout(`janus · workspace ${created.getWorkspaceRoot()}${providerSegment} · model ${created.getModelId()} · ${restored.length} conversation${restored.length === 1 ? '' : 's'} · /help for commands\n`)
  if (activeTitle && activeTitle !== 'New conversation') {
    stdout(`resumed: ${activeTitle}\n`)
  }

  try {
    for (;;) {
      const line = await lines.next('you> ')
      if (line === null) return 0
      const parsed = parseInputLine(line)
      if (parsed.kind === 'empty') continue
      if (parsed.kind === 'command') {
        if (!parsed.known) {
          stderr(`unknown command: /${parsed.command} (type /help)\n`)
          continue
        }
        const outcome = await handleCommand(state, parsed.command as string, parsed.args ?? [])
        if (outcome === 'exit') return 0
        continue
      }
      activeController = new AbortController()
      try {
        await runTurn(state, parsed.text ?? '', activeController.signal)
      } finally {
        activeController = null
      }
    }
  } finally {
    lines.close()
    await state.session.close()
  }
}
