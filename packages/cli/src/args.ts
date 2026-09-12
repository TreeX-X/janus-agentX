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
  provider?: string
  baseUrl?: string
  apiKey?: string
  /** Explicit catalog file. Undefined = headless stays file-free (flags/env only). */
  config?: string
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  /** CodeX parity: reasoning effort (none|minimal|low|medium|high|xhigh|max|ultra). */
  effort?: string
  prompt: string
}

export interface TuiOptions {
  workspace: string
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  /** Explicit catalog file. Undefined = default file; --no-config disables it. */
  config?: string
  noConfig?: boolean
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  /** CodeX parity: reasoning effort (none|minimal|low|medium|high|xhigh|max|ultra). */
  effort?: string
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
  provider?: string
  baseUrl?: string
  apiKey?: string
  config?: string
  noConfig?: boolean
  maxTurns?: number
  timeoutMs?: number
  conversationId?: string
  approvalMode?: ApprovalModeOption
  effort?: string
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
    case '--provider':
    case '-p': {
      const value = takeValue()
      if (!value) return 'Missing --provider value'
      shared.provider = value
      return undefined
    }
    case '--config': {
      const value = takeValue()
      if (!value) return 'Missing --config value'
      shared.config = value
      return undefined
    }
    case '--no-config': {
      shared.noConfig = true
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
    case '--effort': {
      const value = takeValue()
      const level = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(level)) {
        return `Invalid --effort: ${value ?? '(missing)'}. Supported: none|minimal|low|medium|high|xhigh|max|ultra`
      }
      shared.effort = level
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
  if (shared.noConfig && shared.config) return { command: 'help', error: 'Cannot combine --config with --no-config' }
  if (!prompt) return { command: 'help', error: 'Missing prompt. Usage: janus chat [--workspace <dir>] [--model <id>] [--] "prompt"' }
  return {
    command: 'chat',
    chat: {
      workspace: shared.workspace,
      model: shared.model,
      provider: shared.provider,
      baseUrl: shared.baseUrl,
      apiKey: shared.apiKey,
      config: shared.config,
      maxTurns: shared.maxTurns,
      timeoutMs: shared.timeoutMs,
      conversationId: shared.conversationId,
      effort: shared.effort,
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

  if (shared.noConfig && shared.config) return { command: 'help', error: 'Cannot combine --config with --no-config' }

  return {
    command: 'tui',
    tui: {
      workspace: shared.workspace,
      model: shared.model,
      provider: shared.provider,
      baseUrl: shared.baseUrl,
      apiKey: shared.apiKey,
      config: shared.config,
      noConfig: shared.noConfig,
      maxTurns: shared.maxTurns,
      timeoutMs: shared.timeoutMs,
      conversationId: shared.conversationId,
      approvalMode: shared.approvalMode,
      effort: shared.effort,
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
    '  janus [tui] [-C <dir>] [-m <id>] [-p <provider>] [--base-url <url>] [--api-key <key>]',
    '            [--config <path> | --no-config]',
    '            [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run|per-action]',
    '            [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]',
    '            [--conversation <id>] [--fullscreen] [--plain]',
    '      Resident interactive loop (default with no argv); human-readable streaming.',
    '      Model config falls back to JANUS_MODEL / JANUS_BASE_URL / JANUS_API_KEY.',
    '      Reasoning effort falls back to JANUS_EFFORT (default medium). Inspect with /status, switch with /effort.',
    '      Provider keys: --api-key > <apiKeyEnv> > JANUS_API_KEY. Inspect with /status.',
    '      Starts without a model/API key; chat turns then fail until set (/model <id>, /connect).',
    '  janus chat [--workspace <dir>] [--model <id>] [--provider <id>] [--base-url <url>] [--api-key <key>]',
    '             [--config <path>]',
    '             [--max-turns <n>] [--timeout-ms <ms>] [--approval-mode auto-run]',
    '             [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]',
    '             [--conversation <id>] [--] "prompt"',
    '      Run one agent turn against a workspace; ChatAgentEvents stream as JSONL on stdout.',
    '      Model config falls back to JANUS_MODEL / JANUS_BASE_URL / JANUS_API_KEY.',
    '      Headless stays file-free unless --config <path> is given.',
    '  janus version            Print the CLI version.',
    '',
    'Exit codes: 0 done · 1 agent/model error · 2 usage/config error · 130 interrupted.',
  ].join('\n')
}
