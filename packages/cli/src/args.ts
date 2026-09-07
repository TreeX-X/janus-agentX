/**
 * @file Pure argv parsing for the janus CLI (no side effects, unit tested).
 *
 * The CLI drives the janus-agent dialogue/tool-call loop directly
 * (`runChatTurn` over a local `WorkspaceAgentRuntime`). There is no
 * subprocess runner here: no claude/codex/opencode engines.
 */

export type CliCommand = 'chat' | 'version' | 'help'

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

export interface ParsedArgs {
  command: CliCommand
  chat?: ChatOptions
  error?: string
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' }
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    return { command: 'version' }
  }
  if (command !== 'chat') {
    return { command: 'help', error: `Unknown command: ${command}` }
  }

  let workspace = cwd
  let model: string | undefined
  let baseUrl: string | undefined
  let apiKey: string | undefined
  let maxTurns: number | undefined
  let timeoutMs: number | undefined
  let conversationId: string | undefined
  const promptParts: string[] = []
  let separatorSeen = false

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (separatorSeen || !arg.startsWith('-')) {
      promptParts.push(arg)
      continue
    }
    if (arg === '--') {
      separatorSeen = true
      continue
    }
    const takeValue = (): string | undefined => {
      const next = rest[i + 1]
      if (next === undefined || next === '--') return undefined
      i += 1
      return next
    }
    switch (arg) {
      case '--workspace':
      case '-C': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --workspace value' }
        workspace = value
        break
      }
      case '--model':
      case '-m': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --model value' }
        model = value
        break
      }
      case '--base-url': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --base-url value' }
        baseUrl = value
        break
      }
      case '--api-key': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --api-key value' }
        apiKey = value
        break
      }
      case '--max-turns': {
        const value = takeValue()
        const parsed = value === undefined ? NaN : Number(value)
        if (!Number.isInteger(parsed) || parsed <= 0) return { command: 'help', error: `Invalid --max-turns: ${value ?? '(missing)'}` }
        maxTurns = parsed
        break
      }
      case '--timeout-ms': {
        const value = takeValue()
        const parsed = value === undefined ? NaN : Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) return { command: 'help', error: `Invalid --timeout-ms: ${value ?? '(missing)'}` }
        timeoutMs = Math.floor(parsed)
        break
      }
      case '--approval-mode': {
        const value = takeValue()
        // Headless CLI has no approver: per-action would hang on first write.
        if (value !== 'auto-run') return { command: 'help', error: `Invalid --approval-mode: ${value ?? '(missing)'}. Only auto-run is supported headless` }
        break
      }
      case '--conversation': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --conversation value' }
        conversationId = value
        break
      }
      default:
        return { command: 'help', error: `Unknown flag: ${arg}` }
    }
  }

  const prompt = promptParts.join(' ').trim()
  if (!prompt) return { command: 'help', error: 'Missing prompt. Usage: janus chat [--workspace <dir>] [--model <id>] [--] "prompt"' }
  return { command: 'chat', chat: { workspace, model, baseUrl, apiKey, maxTurns, timeoutMs, conversationId, prompt } }
}

export function helpText(): string {
  return [
    'janus - standalone Janus agent CLI (dialogue + workspace tools, no Electron)',
    '',
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
