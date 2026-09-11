/**
 * @file Resident plain-text loop for `janus tui` (M0/M1 `--plain` path).
 * @description Readline over stdin/stdout by default (Tab completes a
 * leading `/` command via `completeSlashCommand`); multi-turn history
 * lives in `CliSession`. All side-effect seams (lines/stdout/stderr/env)
 * are injectable so tests drive turns without a TTY. Ink fullscreen lands
 * in M1 on top of the same session/commands.
 */
import { createInterface } from 'node:readline'
import type { AskUserPortAnswer, ChatTurnPorts, ChatTurnResult } from '@janus-agent/janus-agent'
import type { QuestionPrompt } from './session.js'
import type { TuiOptions } from './args.js'
import { CliSession, isSessionValidationError, type ApprovalPrompt } from './session.js'
import { defaultHistoryDir, fileConversationStore, type ConversationStorePort } from './conversations.js'
import { defaultAuthPath, loadAuthFile } from './auth.js'
import { loadEffectiveCatalog } from './providers.js'
import { buildTracePreviews } from './trace-preview.js'
import { displayText } from './tool-display.js'
import { runConnectWizard, type ConnectAsk, type TestConnectionFn } from './connect.js'
import { EFFORT_META, effortMeta, effortPickerRows, parseEffortPickerInput } from './effort.js'
import { executeCommand } from './tui/exec.js'
import { parseInputLine } from './commands.js'
import { completeSlashCommand } from './tui/composer-state.js'
import {
  normalizeCustomAnswer,
  parseQuestionPickerInput,
  questionPickerRows,
  questionPromptHead,
} from './tui/question-state.js'
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
  /** Auth (key) file path. Undefined = default file unless --no-config, null = no file. */
  authPath?: string | null
  /** Test seam: stub the /connect reachability probe (default hits the network). */
  testConnection?: TestConnectionFn
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
  const rl = createInterface({ input: process.stdin, output: process.stdout, completer: completeSlashCommand })
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
  testConnection?: TestConnectionFn
  outputKind?: 'text' | 'thinking' | 'tool'
}

function renderEvent(state: ReplState, event: unknown): void {
  const { stdout, stderr } = state
  const typed = event as { type?: string; delta?: string; toolName?: string; argumentKeys?: string[]; status?: string; code?: string; retryable?: boolean; cancelled?: boolean; todos?: Array<{ content: string; status: string }> }
  switch (typed.type) {
    case 'text_delta':
      if (typed.delta) {
        if (state.outputKind !== 'text') stdout('\njanus▸ ')
        state.outputKind = 'text'
        stdout(displayText(typed.delta))
      }
      return
    case 'reasoning_delta': {
      if (typed.delta) {
        if (state.outputKind !== 'thinking') stdout('\n▸ thinking · ')
        state.outputKind = 'thinking'
        stdout(displayText(typed.delta))
      }
      return
    }
    case 'tool_call_ready':
      state.outputKind = 'tool'
      stdout(`\n◇ ${typed.toolName ?? 'tool'}${typed.argumentKeys?.length ? ` (${typed.argumentKeys.join(', ')})` : ''}`)
      return
    case 'tool_execution_end':
      state.outputKind = 'tool'
      stdout(`\n${typed.status === 'completed' ? '✔' : '✘'} ${typed.toolName ?? 'tool'} · ${typed.status ?? 'done'}`)
      return
    case 'model_error':
      stderr(`\njanus: model error ${typed.code ?? 'unknown'}${typed.retryable ? ' (retryable)' : ''}`)
      return
    case 'todo_update': {
      // Codex-style live mirror for pipes/plain: one compact block per write.
      const todos = Array.isArray(typed.todos) ? typed.todos : []
      const open = todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
      if (todos.length === 0 || open.length === 0) return
      const done = todos.filter((todo) => todo.status === 'completed').length
      const current = todos.find((todo) => todo.status === 'in_progress')?.content
      state.outputKind = 'tool'
      stdout(`\n○ 待办 ${done}/${todos.length}${current ? ` · 当前: ${current}` : ''}`)
      for (const todo of todos) {
        const mark = todo.status === 'completed' ? '●' : todo.status === 'in_progress' ? '◐' : todo.status === 'cancelled' ? '✕' : '○'
        stdout(`\n  ${mark} ${displayText(todo.content).slice(0, 120)}`)
      }
      return
    }
    case 'question_requested': {
      // The picker itself renders the questions; this line only marks the gate.
      state.outputKind = 'tool'
      stdout('\n◇ ask_user · awaiting your pick (whole call cancels on q/EOF)')
      return
    }
    case 'question_resolved': {
      state.outputKind = 'tool'
      const questionTyped = typed as { status?: string }
      stdout(`\n${questionTyped.status === 'answered' ? '✔' : '✘'} ask_user · ${questionTyped.status ?? 'done'}`)
      return
    }
    case 'stream_end': {
      if (typed.cancelled) stdout('\n■ cancelled — history kept')
      return
    }
    default:
      return
  }
}

async function runTurn(state: ReplState, prompt: string, signal: AbortSignal): Promise<void> {
  state.stdout('janus▸ ')
  state.outputKind = 'text'
  try {
    const result: ChatTurnResult = await state.session.sendTurn(
      prompt,
      {
        onEvent: ({ event }) => renderEvent(state, event),
        onDisplayEvent: (event) => {
          if (event.type !== 'tool-display') return
          const { display } = event
          if (display.output) {
            if (display.summary) state.stdout(`\n  └ ${display.summary}`)
            for (const line of display.output?.slice(0, 6) ?? []) state.stdout(`\n    ${line}`)
          } else if (display.target && !display.output) state.stdout(`\n  ${display.category} › ${display.target}`)
        },
      },
      signal,
    )
    // Post-turn outcome captions + file previews (same data as the Ink cards).
    try {
      for (const preview of buildTracePreviews(state.session.getWorkspaceRoot(), result.toolTraces)) {
        if (!preview.diff.length) continue
        state.stdout(`\n  diff › ${preview.toolName}`)
        for (const line of preview.diff) state.stdout(`\n    ${line}`)
      }
    } catch {
      // Best effort: previews must never fail a turn.
    }
    // Sticky reminder above the next prompt (plain-mode equivalent of the bar).
    try {
      const todos = Array.isArray(result.todos) ? result.todos : []
      const open = todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
      if (todos.length > 0 && open.length > 0 && !result.cancelled) {
        const done = todos.filter((todo) => todo.status === 'completed').length
        const current = todos.find((todo) => todo.status === 'in_progress')?.content
        state.stdout(`\n○ 待办 ${done}/${todos.length}${current ? ` · 当前: ${displayText(current).slice(0, 120)}` : ''}`)
      }
    } catch {
      // Best effort: todo reminders must never fail a turn.
    }
  } catch (error) {
    state.stderr(`\njanus: chat turn failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  state.stdout('\n')
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
  stdout(`◇ approve ${prompt.toolName}[${prompt.workspaceId}] risk=${prompt.actionRisk}${summary}${paths}\n`)
  if (prompt.detail) {
    const lines = prompt.detail.split('\n')
    for (const line of lines.slice(0, 8)) stdout(`  ${line}\n`)
    if (lines.length > 8) stdout(`  … (${lines.length - 8} more)\n`)
  }
  stdout('Allow? [y/N] ')
  const answer = await lines.next('', { signal })
  if (answer === null) return false
  return /^(y|yes)$/i.test(answer.trim())
}

/**
 * Plain-loop picker for `ask_user`: questions arrive sequentially, each
 * rendered as a numbered list. Answers accept numbers (`1,3` for multi),
 * exact labels, `c` for a custom answer, `q` cancels the whole call.
 * EOF/abort cancels the whole call (fail-safe, never partial).
 */
export async function askQuestionPlain(
  lines: ReplLineSource,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  prompt: QuestionPrompt,
  signal: AbortSignal,
): Promise<AskUserPortAnswer> {
  const answers: Array<{ header: string; selected: string[]; custom?: string }> = []
  const total = prompt.questions.length
  for (let index = 0; index < total; index += 1) {
    const question = prompt.questions[index]
    if (!question) continue
    if (signal.aborted) return { status: 'cancelled' }
    stdout(`${questionPromptHead(index, total, question.header)}\n`)
    stdout(`${displayText(question.question).slice(0, 500)}\n`)
    for (const row of questionPickerRows(question)) stdout(`${row}\n`)
    if (question.multiple) stdout('  (multi: comma-separated, e.g. 1,3)\n')
    let retries = 0
    for (;;) {
      if (signal.aborted) return { status: 'cancelled' }
      stdout(`select [1-${question.options.length}${prompt.allowCustom ? '|c=custom' : ''}|q=cancel]: `)
      const raw = await lines.next('', { signal })
      if (raw === null) return { status: 'cancelled' }
      const parsed = parseQuestionPickerInput(raw, question, prompt.allowCustom)
      if (parsed.action === 'cancel') return { status: 'cancelled' }
      if (parsed.action === 'empty') continue
      if (parsed.action === 'custom') {
        stdout('custom answer (empty cancels): ')
        const customRaw = await lines.next('', { signal })
        if (customRaw === null) return { status: 'cancelled' }
        const normalized = normalizeCustomAnswer(customRaw)
        if (!normalized.ok) return { status: 'cancelled' }
        answers.push({ header: question.header, selected: [], custom: normalized.custom })
        break
      }
      if (parsed.action === 'error') {
        retries += 1
        stderr(`${parsed.message}\n`)
        if (retries >= 3) return { status: 'cancelled' }
        continue
      }
      answers.push({ header: question.header, selected: parsed.selected })
      break
    }
  }
  return { status: 'answered', answers }
}

/**
 * Plain-loop interactive picker for bare `/effort` (numbered list +
 * follow-up prompt). Mirrors the Ink `EffortPanel`: numbers, names,
 * Enter/EOF keeps the current level.
 */
async function runEffortPicker(state: ReplState): Promise<'continue' | 'exit'> {
  const current = state.session.getEffort()
  state.stdout(`effort: ${current}\n`)
  for (const row of effortPickerRows(current)) state.stdout(`${row}\n`)
  state.stdout(`select effort [1-${EFFORT_META.length}|name] (Enter keeps ${current}): `)
  const answer = await state.lines.next('')
  if (answer === null) {
    state.stdout(`effort unchanged: ${current}\n`)
    return 'continue'
  }
  const selection = parseEffortPickerInput(answer)
  if (selection.action === 'cancel') {
    state.stdout(`effort unchanged: ${current}\n`)
    return 'continue'
  }
  if (selection.action === 'error') {
    state.stderr(`${selection.message}\n`)
    return 'continue'
  }
  try {
    state.session.setEffort(selection.level)
    const meta = effortMeta(selection.level)
    state.stdout(`effort switched: ${selection.level} — ${meta.hint} (${meta.detail})\n`)
  } catch (error) {
    state.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
  }
  return 'continue'
}

async function handleCommand(state: ReplState, command: string, args: string[]): Promise<'continue' | 'exit' | 'recreated'> {
  // Bare /effort is interactive in the plain loop (Ink uses EffortPanel);
  // `/effort <level|number>` still switches directly via executeCommand.
  if (command === 'effort' && args.length === 0) return runEffortPicker(state)
  const outcome = await executeCommand(state.session, command, args, {
    recreateWorkspace: async (dir) => {
      const next = await CliSession.create({
        workspace: dir,
        model: state.session.getModelId(),
        baseUrl: state.options.baseUrl,
        apiKey: state.session.getApiKey() ?? state.options.apiKey,
        maxTurns: undefined,
        timeoutMs: state.options.timeoutMs,
        approvalMode: state.session.getApprovalMode(),
        effort: state.session.getEffort(),
        env: state.env,
        store: state.store,
        catalog: state.session.getCatalog(),
        providerId: state.session.getProviderId(),
        configPath: state.session.getConfigPath(),
        authKeys: state.session.getAuthKeys(),
        authPath: state.session.getAuthPath(),
        onApproval: state.session.getApprovalHandler(),
        onQuestion: (prompt, signal) => askQuestionPlain(state.lines, state.stdout, state.stderr, prompt, signal),
        onCatalogError: state.session.getCatalogErrorHandler(),
        streamTextFn: state.streamTextFn,
      })
      if (isSessionValidationError(next)) return { ok: false, message: next.message }
      await state.session.close()
      state.session = next
      return { ok: true, message: `workspace switched: ${next.getWorkspaceRoot()} (history cleared)` }
    },
  })
  for (const line of outcome.stdout) state.stdout(`${line}\n`)
  for (const line of outcome.stderr) state.stderr(`${line}\n`)
  if (outcome.exit) return 'exit'
  if (outcome.connect) {
    const ask: ConnectAsk = async (prompt, opts) => {
      // Plain readline cannot mask input: say so once per secret prompt.
      if (opts?.secret) state.stdout(`${prompt}(input is visible here; the key is still only saved to auth.json)\n`)
      return state.lines.next(opts?.secret ? '' : prompt)
    }
    await runConnectWizard(state.session, {
      ask,
      print: (line) => state.stdout(`${line}\n`),
      warn: (line) => state.stderr(`${line}\n`),
    }, {
      ref: outcome.connect.ref,
      key: outcome.connect.key,
      baseURL: outcome.connect.baseURL,
      testConnection: state.testConnection,
    })
    return 'continue'
  }
  return outcome.workspaceSwitched ? 'recreated' : 'continue'
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
    // Explicit test seam wins (null = no file, even when flags exist);
    // otherwise --config/--no-config, else the default file.
    configPath: io.configPath !== undefined
      ? io.configPath
      : (options.noConfig ? null : (options.config ?? undefined)),
    model: options.model,
    baseUrl: options.baseUrl,
    onError: () => warnOnce('janus: provider config unreadable, using flags/env only.\n'),
  })
  // Keys are user-global (auth.json), independent of the catalog file choice;
  // --no-config opts out of every file. Same null/undefined seam as above.
  const authPath = io.authPath !== undefined
    ? io.authPath
    : (options.noConfig ? null : defaultAuthPath())
  const auth = authPath ? loadAuthFile(authPath, () => warnOnce('janus: auth file unreadable, using env only.\n')) : { version: 1 as const, keys: {} }
  const state: ReplState = {
    session: undefined as unknown as CliSession,
    options,
    env,
    stdout,
    stderr,
    store,
    lines,
    streamTextFn: io.streamTextFn,
    testConnection: io.testConnection,
    outputKind: undefined,
  }

  const created = await CliSession.create({
    ...options,
    env,
    store,
    catalog: catalogInput.catalog,
    configPath: catalogInput.configPath,
    providerId: options.provider,
    authKeys: auth.keys,
    authPath,
    onAuthError: () => warnOnce('janus: auth file not writable, keys last this run only.\n'),
    onApproval: (prompt, signal) => askApproval(lines, stdout, prompt, signal),
    onQuestion: (prompt, signal) => askQuestionPlain(lines, stdout, stderr, prompt, signal),
    onCatalogError: () => warnOnce('janus: provider config not writable, switches last this run only.\n'),
    streamTextFn: io.streamTextFn,
  })
  if (isSessionValidationError(created)) {
    stderr(`${created.message}\n`)
    return 2
  }
  if (!created.getModelId()) {
    stderr('janus: no model — entering without model access. Set one with /model <id>, --model, or JANUS_MODEL.\n')
  }
  if (!created.hasApiKey()) {
    stderr('janus: no API key — entering without model access. Set one with /connect, /key <key>, --api-key, or JANUS_API_KEY.\n')
  }
  // Every restart begins with a new empty conversation; previous ones are
  // dropped. An explicit --conversation id opts back into resume.
  if (!options.conversationId) {
    await created.startFreshConversation()
  }
  state.session = created

  stdout(`${options.plain ? renderLogoPlain() : renderLogoAscii()}\n`)
  const restored = created.listConversations()
  const activeTitle = restored.find((summary) => summary.active)?.title ?? ''
  const providerSegment = created.listProviders().entries.length > 1 ? ` · provider ${created.getProviderId()}` : ''
  stdout(`janus · workspace ${created.getWorkspaceRoot()}${providerSegment} · model ${created.getModelId() ?? '(no model)'} · effort ${created.getEffort()} · ${restored.length} conversation${restored.length === 1 ? '' : 's'} · /help for commands\n`)
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
