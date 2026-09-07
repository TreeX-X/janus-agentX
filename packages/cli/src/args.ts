/**
 * @file Pure argv parsing for the janus CLI (no side effects, unit tested).
 */
import type { AgentEngine } from '@janus-agent/agent-core'

export type CliCommand = 'run' | 'resolve' | 'version' | 'help'

export interface RunOptions {
  engine: AgentEngine
  cwd: string
  model?: string
  timeoutMs?: number
  approvalMode?: 'per-action' | 'auto-run'
  prompt: string
}

export interface ParsedArgs {
  command: CliCommand
  run?: RunOptions
  resolveEngine?: AgentEngine
  error?: string
}

const ENGINES: AgentEngine[] = ['claude', 'codex', 'opencode']

function isEngine(value: string): value is AgentEngine {
  return (ENGINES as string[]).includes(value)
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' }
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    return { command: 'version' }
  }
  if (command === 'resolve') {
    const engine = rest[0] ?? 'codex'
    if (!isEngine(engine)) return { command: 'help', error: `Unknown engine: ${engine}` }
    return { command: 'resolve', resolveEngine: engine }
  }
  if (command !== 'run') {
    return { command: 'help', error: `Unknown command: ${command}` }
  }

  let engine: AgentEngine = 'codex'
  let dir = cwd
  let model: string | undefined
  let timeoutMs: number | undefined
  let approvalMode: RunOptions['approvalMode']
  const promptParts: string[] = []
  let separatorSeen = false

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (separatorSeen || (!arg.startsWith('-') && !arg.startsWith('/'))) {
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
      case '--engine':
      case '-e': {
        const value = takeValue()
        if (!value || !isEngine(value)) return { command: 'help', error: `Invalid --engine: ${value ?? '(missing)'}` }
        engine = value
        break
      }
      case '--cwd':
      case '-C': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --cwd value' }
        dir = value
        break
      }
      case '--model':
      case '-m': {
        const value = takeValue()
        if (!value) return { command: 'help', error: 'Missing --model value' }
        model = value
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
        if (value !== 'per-action' && value !== 'auto-run') {
          return { command: 'help', error: `Invalid --approval-mode: ${value ?? '(missing)'}` }
        }
        approvalMode = value
        break
      }
      default:
        return { command: 'help', error: `Unknown flag: ${arg}` }
    }
  }

  const prompt = promptParts.join(' ').trim()
  if (!prompt) return { command: 'help', error: 'Missing prompt. Usage: janus run [--engine codex] [--] "prompt"' }
  return { command: 'run', run: { engine, cwd: dir, model, timeoutMs, approvalMode, prompt } }
}

export function helpText(): string {
  return [
    'janus - standalone Janus agent CLI',
    '',
    '  janus run [--engine codex|claude|opencode] [--cwd <dir>] [--model <id>]',
    '            [--timeout-ms <ms>] [--approval-mode per-action|auto-run] [--] "prompt"',
    '      Run one headless agent turn; AgentEvents stream as JSONL on stdout.',
    '  janus resolve [engine]   Print the resolved CLI binary path (exit 3 if missing).',
    '  janus version            Print the CLI version.',
    '',
    'Exit codes: 0 done · 1 agent error · 2 usage/config error · 3 binary missing · 130 interrupted.',
  ].join('\n')
}
