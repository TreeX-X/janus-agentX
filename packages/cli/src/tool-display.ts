import { stripVTControlCharacters } from 'node:util'
import { redactPolicyValue, type AgentStreamEvent, type ToolResult } from '@janus-agent/agent-core'
import { toolTraceEntryFromResult } from '@janus-agent/chat-core'

export type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'git' | 'project' | 'tool'
export interface ToolDisplay {
  category: ToolCategory
  target: string
  output?: string[]
  summary?: string
  durationMs?: number
  failed?: boolean
}
export type CliDisplayEvent =
  | { type: 'tool-display'; callId: string; display: ToolDisplay }
  | { type: 'usage'; promptTokens: number; completionTokens: number }

export function displayText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeText(value: unknown, limit = 600): string {
  const safe = redactPolicyValue(value)
  return displayText(typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '').slice(0, limit)
}

export function toolCategory(name: string): ToolCategory {
  const normalized = name.replace(/[._-]/g, '').toLowerCase()
  if (/^workspace(read|list)$/.test(normalized)) return 'read'
  if (normalized === 'workspacesearch') return 'search'
  if (/^workspace(edit|create)$/.test(normalized)) return 'edit'
  if (normalized === 'commandrun' || normalized === 'projectprocessoutput') return 'command'
  if (normalized.startsWith('git')) return 'git'
  if (normalized.startsWith('project')) return 'project'
  return 'tool'
}

/** Bound output before it enters React state; credentials follow the runtime redactor. */
function outputLines(value: unknown): string[] {
  const output = record(value)
  const body = output.stdout ?? output.output ?? output.content ?? output.diff ?? output.matches ?? output.entries ?? value
  const text = Array.isArray(body)
    ? body.slice(0, 81).map((item) => {
      const entry = record(item)
      if (typeof entry.path === 'string') {
        return safeText(`${entry.path}${entry.line !== undefined ? `:${entry.line}` : ''}${entry.text !== undefined ? `  ${entry.text}` : ''}`)
      }
      return safeText(item)
    }).join('\n')
    : typeof body === 'string' ? safeText(body, 12000) : displayText(JSON.stringify(redactPolicyValue(body), null, 2) ?? '').slice(0, 12000)
  const lines = text.split('\n')
  const shown = lines.slice(0, 80).map((line) => line.slice(0, 400))
  if (lines.length > 80 || text.length >= 12000 || output.outputTruncated === true) shown.push('[output truncated]')
  if (typeof output.stderr === 'string' && output.stderr) shown.push('stderr:', ...safeText(output.stderr, 2000).split('\n').slice(0, 12))
  return shown
}

export function toDisplayEvent(event: AgentStreamEvent): CliDisplayEvent | undefined {
  if (event.type === 'finish' && event.usage) return { type: 'usage', ...event.usage }
  if (event.type !== 'tool_call_ready'
    && event.type !== 'tool_execution_update' && event.type !== 'tool_execution_end') return undefined
  const args = record(redactPolicyValue(event.call.arguments))
  const category = toolCategory(event.call.name)
  const target = ['path', 'query', 'program', 'args', 'cwd', 'command', 'projectId', 'message'].filter((key) => args[key] !== undefined)
    .map((key) => `${key}: ${safeText(args[key], 240)}`).join(' · ')
  const display: ToolDisplay = { category, target }
  if (event.type === 'tool_execution_update') display.output = outputLines(event.partialResult)
  if (event.type === 'tool_execution_end') {
    const details = record(event.result.details)
    const output = record(details.output)
    display.failed = event.isError || output.ok === false || output.timedOut === true
      || (category === 'command' && typeof output.exitCode === 'number' && output.exitCode !== 0)
    if (typeof details.toolName === 'string') {
      const trace = toolTraceEntryFromResult(details as unknown as ToolResult)
      display.summary = safeText(trace.errorDetail ?? trace.summary)
      display.durationMs = typeof details.durationMs === 'number' ? details.durationMs : undefined
      display.output = outputLines(details.output ?? details.error ?? event.result.content)
    } else {
      display.summary = event.isError ? safeText(event.result.content) : undefined
      display.output = outputLines(event.result.content)
    }
    // Show this call's applied changes, independent of pre-existing working-tree edits.
    if (category === 'edit' && !display.failed) {
      if (typeof args.content === 'string') display.output = outputLines(args.content.split('\n').map((line) => `+${line}`).join('\n'))
      else if (typeof args.unifiedDiff === 'string') display.output = outputLines(args.unifiedDiff)
      else if (Array.isArray(args.replacements)) display.output = outputLines(args.replacements.map((replacement) => {
        const edit = record(replacement)
        return [String(edit.oldText ?? '').split('\n').map((line) => `-${line}`).join('\n'),
          String(edit.newText ?? '').split('\n').map((line) => `+${line}`).join('\n')].join('\n')
      }).join('\n'))
    }
  }
  return { type: 'tool-display', callId: event.call.id, display }
}
