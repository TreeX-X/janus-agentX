import type { AgentStreamToolCall } from './types'

interface PendingToolCall {
  name?: string
  argumentsText: string
  oversized?: boolean
}

export type ToolCallInvalidKind = 'missing-name' | 'json' | 'missing-arguments' | 'validation' | 'too_large'

export interface ToolCallAccumulatorOptions {
  validate?: (call: AgentStreamToolCall) => string | undefined
  /** Upper bound for one call's streamed argument text; exceeded calls fail closed. */
  maxArgumentsChars?: number
}

/** Preview length for malformed argument text surfaced in recovery guidance. */
const RAW_PREVIEW_CHARS = 300

export type ToolCallResolution =
  | { status: 'ready'; call: AgentStreamToolCall }
  | { status: 'invalid'; kind: ToolCallInvalidKind; error: string; rawPreview?: string; arguments?: unknown }
  | { status: 'duplicate' }
  | { status: 'aborted' }

export class ToolCallAccumulator {
  private readonly pending = new Map<string, PendingToolCall>()
  private readonly completed = new Set<string>()
  private readonly aborted = new Set<string>()

  constructor(private readonly options: ToolCallAccumulatorOptions = {}) {}

  private get maxArgumentsChars(): number {
    return this.options.maxArgumentsChars ?? 2 * 1024 * 1024
  }

  start(callId: string, name?: string): boolean {
    if (!callId || this.completed.has(callId) || this.aborted.has(callId)) return false
    const current = this.pending.get(callId)
    if (current) {
      if (!current.name && name) current.name = name
      return false
    }
    this.pending.set(callId, { name, argumentsText: '' })
    return true
  }

  append(callId: string, argumentsDelta: string, name?: string): boolean {
    if (!callId || this.completed.has(callId) || this.aborted.has(callId)) return false
    // Empty deltas carry no information; ignore them so the UI never spins on
    // no-op updates for an otherwise idle call.
    if (!argumentsDelta) return false
    this.start(callId, name)
    const current = this.pending.get(callId)
    if (!current) return false
    if (!current.name && name) current.name = name
    if (current.argumentsText.length + argumentsDelta.length > this.maxArgumentsChars) {
      current.oversized = true
    }
    current.argumentsText += argumentsDelta
    return true
  }

  complete(input: { callId: string; name?: string; arguments?: unknown }): ToolCallResolution {
    const { callId } = input
    if (this.aborted.has(callId)) return { status: 'aborted' }
    if (this.completed.has(callId)) return { status: 'duplicate' }

    this.start(callId, input.name)
    const current = this.pending.get(callId)
    this.pending.delete(callId)
    this.completed.add(callId)

    const name = input.name ?? current?.name
    if (!name) return { status: 'invalid', kind: 'missing-name', error: 'Tool call is missing a name' }

    if (current?.oversized) {
      return {
        status: 'invalid',
        kind: 'too_large',
        error: `Tool call arguments exceed ${this.maxArgumentsChars} characters. Shrink the arguments (narrower line ranges, fewer replacements) and retry the call.`,
      }
    }

    let argumentsValue: unknown
    let rawPreview: string | undefined
    try {
      const source = input.arguments ?? current?.argumentsText
      argumentsValue = typeof source === 'string' ? JSON.parse(source) : source
    } catch {
      const raw = typeof current?.argumentsText === 'string' && current.argumentsText.length > 0
        ? current.argumentsText
        : undefined
      rawPreview = raw?.slice(0, RAW_PREVIEW_CHARS)
      return { status: 'invalid', kind: 'json', error: 'Tool call arguments are not valid JSON', rawPreview }
    }

    if (argumentsValue === undefined) {
      return { status: 'invalid', kind: 'missing-arguments', error: 'Tool call is missing arguments' }
    }

    const call: AgentStreamToolCall = { id: callId, name, arguments: argumentsValue }
    const validationError = this.options.validate?.(call)
    return validationError
      ? { status: 'invalid', kind: 'validation', error: validationError, arguments: argumentsValue }
      : { status: 'ready', call }
  }

  abort(callId: string): void {
    this.pending.delete(callId)
    this.aborted.add(callId)
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
