/**
 * @file Pure slash-command parsing for the resident TUI loop.
 * @description `/`-prefixed lines are commands; everything else is chat
 * input. No side effects, unit tested. Multi-session commands
 * (/new /list /switch /rename /delete) and /provider land with §4.6 (M1/M2);
 * unknown commands stay an error so typos never reach the model.
 */

export type BuiltinCommandName =
  | 'help'
  | 'key'
  | 'model'
  | 'effort'
  | 'provider'
  | 'connect'
  | 'status'
  | 'workspace'
  | 'clear'
  | 'exit'
  | 'new'
  | 'list'
  | 'switch'
  | 'rename'
  | 'delete'
  | 'approval'

export interface ParsedInput {
  kind: 'input' | 'command' | 'empty'
  /** Raw chat text when kind === 'input'. */
  text?: string
  /** Command name lower-cased when kind === 'command'. */
  command?: BuiltinCommandName | string
  /** Known-command flag; unknown names keep kind === 'command' with known === false. */
  known?: boolean
  args?: string[]
}

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'key',
  'model',
  'effort',
  'provider',
  'connect',
  'status',
  'workspace',
  'clear',
  'exit',
  'new',
  'list',
  'switch',
  'rename',
  'delete',
  // Staged for §4.6 M2 (parsed as known, executed later):
  'approval',
])

function splitArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter((part) => part.length > 0)
}

export function parseInputLine(line: string): ParsedInput {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty' }
  if (!trimmed.startsWith('/')) return { kind: 'input', text: trimmed }
  const [name, ...args] = splitArgs(trimmed.slice(1))
  if (!name) return { kind: 'empty' }
  const command = name.toLowerCase()
  return { kind: 'command', command, known: KNOWN_COMMANDS.has(command), args }
}

export function isKnownCommand(name: string): boolean {
  return KNOWN_COMMANDS.has(name.toLowerCase())
}

/** Ordered known-command names (single source for completion coverage checks). */
export const KNOWN_COMMAND_NAMES: readonly string[] = [...KNOWN_COMMANDS]

export function commandHelpText(): string {
  return [
    'Commands:',
    '  /help                 Show this help.',
    '  /key [api-key]        Show key status or set the API key (memory only).',
    '  /model [id]           List models or switch the model.',
    '  /effort [level|num]   Pick reasoning effort (bare opens picker) or switch directly.',
    '  /provider [id]        List providers or switch provider.',
    '  /provider rm <id>     Remove a provider (and its auth.json key).',
    '  /connect [id] [key] [base-url]',
    '                          Provider setup wizard (key lands in auth.json).',
    '  /status               Show the effective provider/model/baseURL/key/config.',
    '  /workspace <dir>      Switch workspace (history is cleared).',
    '  /clear                Clear this conversation history.',
    '  /new [title]          Start a conversation (and switch to it).',
    '  /list                 List conversations (* = active).',
    '  /switch <n|id>        Switch conversation.',
    '  /rename <title>       Rename the active conversation.',
    '  /delete [n|id]        Delete a conversation (default: active).',
    '  /approval [mode]      Show or switch auto-run|per-action.',
    '  /exit                 Leave janus.',
      'Keys: Enter send · ↑/↓ input history · Shift+←→/↑↓/Home/End select text · Ctrl+A select all · Ctrl+C copy selection (else clear input / cancel turn; twice within 1s exit) · Ctrl+X cut · Ctrl+V paste · Esc clear selection / cancel turn · Ctrl+D exit · Ctrl+T thinking · Ctrl+O tool output · Ctrl+E todos · PgUp/PgDn scroll · Ctrl+Home/End top/bottom · Ctrl+↑/↓ step.',
    '      Mouse: plain drag selects natively (copy/paste via the terminal); JANUS_MOUSE=1 hands the mouse to the app: wheel scroll plus constrained input drag-select with auto-copy (native selection off while on; tmux needs `set -g mouse on`).',
    'Panels: Ctrl+P command palette (provider setup, status, …).',
    'Mid-turn: the agent may ask option questions (TUI: ↑↓/Space/c/Enter/Esc · plain: numbers/labels/c/q).',
  ].join('\n')
}
