/**
 * @file Pure slash-command parsing for the resident TUI loop.
 * @description `/`-prefixed lines are commands; everything else is chat
 * input. No side effects, unit tested. Multi-session commands
 * (/new /list /switch /rename /delete) and /provider land with §4.6 (M1/M2);
 * unknown commands stay an error so typos never reach the model.
 */

export type BuiltinCommandName =
  | 'help'
  | 'model'
  | 'provider'
  | 'workspace'
  | 'clear'
  | 'exit'

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
  'model',
  'provider',
  'workspace',
  'clear',
  'exit',
  // §4.6 staged (parsed as known, executed from M1/M2 on):
  'new',
  'list',
  'switch',
  'rename',
  'delete',
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

export function commandHelpText(): string {
  return [
    'Commands:',
    '  /help                 Show this help.',
    '  /model [id]           Show or switch the model (/provider first when multi-provider lands).',
    '  /provider [id]        (M2) List or switch providers.',
    '  /workspace <dir>      Switch workspace (history is cleared).',
    '  /clear                Clear this conversation history.',
    '  /new /list /switch /rename /delete   (M1) Manage conversations.',
    '  /approval [mode]      (M2) Show or switch auto-run|per-action.',
    '  /exit                 Leave janus.',
    'Keys: Enter send · Ctrl+C cancel current turn · Ctrl+D exit.',
  ].join('\n')
}
