/**
 * @file Pure argv parsing for the janus CLI (no side effects, unit tested).
 *
 * The CLI drives the janus-agent dialogue/tool-call loop directly
 * (`runChatTurn` over a local `WorkspaceAgentRuntime`). There is no
 * subprocess runner here: no claude/codex/opencode engines.
 *
 * `chat` is the one-shot headless turn (JSONL on stdout, process exits).
 * `tui` (also the default with no argv) is the resident interactive loop.
 */

export type CliCommand = 'chat' | 'tui' | 'version' | 'help'

export type ApprovalModeOption = 'auto-run' | 'per-action'

export interface ChatOptions {
  workspace: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  prompt: string
}

export interface TuiOptions {
  workspace: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  fullscreen?: boolean
  plain?: boolean
}

export interface ParsedArgs {
  command: CliCommand
  chat?: ChatOptions
  tui?: TuiOptions
  error?: string
}

interface SharedOptions {
  workspace: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  fullscreen?: boolean
  plain?: boolean
}

function parseSharedFlag(
  arg: string,
  rest: string[],
  index: { value: number },
  shared: SharedOptions,
  opts: { allowPerActionApproval: boolean },
): string | undefined {
  const takeValue = (): string | undefined => {
    const next = rest[index.value + 1]
    if (next === undefined || next === '--') return undefined
    index.value += 1
    return next
  }
  switch (arg) {
    case '--workspace':
    case '-C': {
      const value = takeValue()
      if (!value) return 'Missing --workspace value'
      shared.workspace = value
      return undefined
    }
    case '--model':
    case '-m': {
      const value = takeValue()
      if (!value) return 'Missing --model value'
      shared.model = value
      return undefined
    }
    case '--base-url': {
      const value = takeValue()
      if (!value) return 'Missing --base-url value'
      shared.baseUrl = value
      return undefined
    }
    case '--api-key': {
      const value = takeValue()
      if (!value) return 'Missing --api-key value'
      shared.apiKey = value
      return undefined
    }
    case '--max-turns': {
      const value = takeValue()
      const parsed = value === undefined ? NaN : Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) return `Invalid --max-turns: ${value ?? '(missing)'}`
      shared.maxTurns = parsed
      return undefined
    }
    case '--timeout-ms': {
      const value = takeValue()
      const parsed = value === undefined ? NaN : Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) return `Invalid --timeout-ms: ${value ?? '(missing)'}`
      shared.timeoutMs = Math.floor(parsed)
      return undefined
    }
    case '--approval-mode': {
      const value = takeValue()
      if (value !== 'auto-run' && !(opts.allowPerActionApproval && value === 'per-action')) {
        return opts.allowPerActionApproval
          ? `Invalid --approval-mode: ${value ?? '(missing)'}. Supported: auto-run, per-action`
          : `Invalid --approval-mode: ${value ?? '(missing)'}. Only auto-run is supported headless`
      }
      shared.approvalMode = value
      return undefined
    }
    case '--conversation': {
      const value = takeValue()
      if (!value) return 'Missing --conversation value'
      shared.conversationId = value
      return undefined
    }
    case '--fullscreen': {
      shared.fullscreen = true
      return undefined
    }
    case '--plain': {
      shared.plain = true
      return undefined
    }
    default:
      return `Unknown flag: ${arg}`
  }
}

function parseChat(argv: string[], cwd: string): ParsedArgs {
  const shared: SharedOptions = { workspace: cwd }
  const promptParts: string[] = []
  let separatorSeen = false
  const index = { value: 0 }

  for (; index.value < argv.length; index.value += 1) {
    const arg = argv[index.value]
    if (separatorSeen || !arg.startsWith('-')) {
      promptParts.push(arg)
      continue
    }
    if (arg === '--') {
      separatorSeen = true
      continue
    }
    if (arg === '--fullscreen' || arg === '--plain') {
      return { command: 'help', error: `${arg} is only supported by janus tui` }
    }
    const error = parseSharedFlag(arg, argv, index, shared, { allowPerActionApproval: false })
    if (error) return { command: 'help', error }
  }

  const prompt = promptParts.join(' ').trim()
  if (!prompt) return { command: 'help', error: 'Missing prompt. Usage: janus chat [--workspace <dir>] [--model <id>] [--] "prompt"' }
  return {
    command: 'chat',
    chat: {
      workspace: shared.workspace,
      model: shared.model,
      baseUrl: shared.baseUrl,
      apiKey: shared.apiKey,
      maxTurns: shared.maxTurns,
      timeoutMs: shared.timeoutMs,
      conversationId: shared.conversationId,
      prompt,
    },
  }
}

function parseTui(argv: string[], cwd: string): ParsedArgs {
  const shared: SharedOptions = { workspace: cwd }
  const index = { value: 0 }

  for (; index.value < argv.length; index.value += 1) {
    const arg = argv[index.value]
    if (arg === '--') {
      return { command: 'help', error: 'janus tui takes no prompt argument; type interactively after launch' }
    }
    if (!arg.startsWith('-')) {
      return { command: 'help', error: `Unexpected argument: ${arg}. janus tui takes no prompt argument; type interactively after launch` }
    }
    const error = parseSharedFlag(arg, argv, index, shared, { allowPerActionApproval: true })
    if (error) return { command: 'help', error }
  }

  return {
    command: 'tui',
    tui: {
      workspace: shared.workspace,
      model: shared.model,
      baseUrl: shared.baseUrl,
      apiKey: shared.apiKey,
      maxTurns: shared.maxTurns,
      timeoutMs: shared.timeoutMs,
      conversationId: shared.conversationId,
      approvalMode: shared.approvalMode,
      fullscreen: shared.fullscreen,
      plain: shared.plain,
    },
  }
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  const [command, ...rest] = argv
  // No argv = resident TUI (opencode-style default).
  if (!command) {
    return { command: 'tui', tui: { workspace: cwd } }
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' }
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    return { command: 'version' }
  }
  if (command === 'tui') {
    return parseTui(rest, cwd)
  }
  if (command !== 'chat') {
    return { command: 'help', error: `Unknown command: ${command}` }
  }
  return parseChat(rest, cwd)
}

export function helpText(): string {
  return [
    'janus - standalone Janus agent CLI (dialogue + workspace tools, no Electron)',
    '',
    '  janus [tui] [-C <dir>] [-m <id>] [--base-url <url>] [--api-key <key>]',
    '            [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run|per-action]',
    '            [--conversation <id>] [--fullscreen] [--plain]',
    '      Resident interactive loop (default with no argv); human-readable streaming.',
    '      Model config falls back to JANUS_MODEL / JANUS_BASE_URL / JANUS_API_KEY.',
    '  janus chat [--workspace <dir>] [--model <id>] [--base-url <url>] [--api-key <key>]',
    '             [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run]',
    '             [--conversation <id>] [--] "prompt"',
    '      Run one agent turn against a workspace; ChatAgentEvents stream as JSONL on stdout.',
    '      Model config falls back to JANUS_MODEL / JANUS_BASE_URL / JANUS_API_KEY.',
    '  janus version            Print the CLI version.',
    '',
    'Exit codes: 0 done · 1 agent/model error · 2 usage/config error · 130 interrupted.',
  ].join('\n')
}
