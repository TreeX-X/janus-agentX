/**
 * @file Resident plain-text loop for `janus tui` (M0/M1 `--plain` path).
 * @description Readline over stdin/stdout by default; multi-turn history
 * lives in `CliSession`. All side-effect seams (lines/stdout/stderr/env)
 * are injectable so tests drive turns without a TTY. Ink fullscreen lands
 * in M1 on top of the same session/commands.
 */
import { createInterface, type Interface } from 'node:readline'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { TuiOptions } from './args.js'
import { CliSession, isSessionValidationError, DEFAULT_BASE_URL } from './session.js'
import { commandHelpText, parseInputLine } from './commands.js'
import { renderLogoAscii, renderLogoPlain } from './logo.js'

export interface ReplLineSource {
  next(prompt?: string): Promise<string | null>
  close(): void
}

export interface ReplIO {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  env?: NodeJS.ProcessEnv
  lines?: ReplLineSource
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

function createReadlineSource(stdout: (text: string) => void): ReplLineSource {
  let rl: Interface | undefined
  let sigintHandler: (() => void) | undefined
  return {
    next: (prompt = 'you> ') => new Promise<string | null>((resolve) => {
      if (!rl) {
        rl = createInterface({ input: process.stdin, output: process.stdout })
        rl.on('close', () => resolve(null))
        if (sigintHandler) rl.on('SIGINT', sigintHandler)
      }
      const current = rl
      current.once('SIGINT', () => {
        sigintHandler?.()
        // Re-issue the prompt; the turn abort is handled via the controller.
        current.prompt()
      })
      current.question(prompt, (answer) => resolve(answer))
    }),
    close: () => rl?.close(),
  }
}

interface ReplState {
  session: CliSession
  options: TuiOptions
  env: NodeJS.ProcessEnv
  stdout: (text: string) => void
  stderr: (text: string) => void
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

function resolveModelTransport(state: ReplState): { baseURL: string; apiKey: string | undefined; modelId: string | undefined } {
  return {
    baseURL: state.options.baseUrl ?? state.env.JANUS_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: state.options.apiKey ?? state.env.JANUS_API_KEY,
    modelId: state.options.model ?? state.env.JANUS_MODEL,
  }
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

async function handleCommand(state: ReplState, command: string, args: string[]): Promise<'continue' | 'exit' | 'recreated'> {
  const { stdout, stderr } = state
  switch (command) {
    case 'help':
      stdout(`${commandHelpText()}\n`)
      return 'continue'
    case 'exit':
      return 'exit'
    case 'clear':
      state.session.clearHistory()
      stdout('history cleared.\n')
      return 'continue'
    case 'model': {
      if (args.length === 0) {
        stdout(`model: ${state.session.getModelId()}\n`)
        return 'continue'
      }
      const transport = resolveModelTransport(state)
      if (!transport.apiKey) {
        stderr('janus: missing API key. Pass --api-key <key> or set JANUS_API_KEY.\n')
        return 'continue'
      }
      state.session.setModel(args[0], { baseURL: transport.baseURL, apiKey: transport.apiKey })
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
    case 'provider':
      stdout('(M2) provider switching is not implemented yet; use /model <id> for now.\n')
      return 'continue'
    case 'new':
    case 'list':
    case 'switch':
    case 'rename':
    case 'delete':
      stdout(`(M1) /${command} (multi-conversation) is not implemented yet; /clear resets this conversation.\n`)
      return 'continue'
    case 'approval':
      if (args.length === 0) {
        stdout(`approval: ${state.session.getApprovalMode()}\n`)
        return 'continue'
      }
      stdout('(M2) approval switching is not implemented yet; this session stays auto-run.\n')
      return 'continue'
    default:
      stderr(`unknown command: /${command} (type /help)\n`)
      return 'continue'
  }
}

export async function runRepl(options: TuiOptions, io: ReplIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text))
  const env = io.env ?? process.env
  const state: ReplState = {
    session: undefined as unknown as CliSession,
    options,
    env,
    stdout,
    stderr,
    streamTextFn: io.streamTextFn,
  }

  const created = await CliSession.create({ ...options, env, streamTextFn: io.streamTextFn })
  if (isSessionValidationError(created)) {
    stderr(`${created.message}\n`)
    return 2
  }
  state.session = created

  stdout(`${options.plain ? renderLogoPlain() : renderLogoAscii()}\n`)
  stdout(`janus · workspace ${created.getWorkspaceRoot()} · model ${created.getModelId()} · /help for commands\n`)

  const lines = io.lines ?? createReadlineSource(stdout)
  let activeController: AbortController | null = null
  if (!io.lines) {
    process.once('SIGINT', () => {
      if (activeController) activeController.abort()
      else lines.close()
    })
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
