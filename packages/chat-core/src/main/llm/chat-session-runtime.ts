import type { ModelInfo } from '../../shared/ipc/model-types'
import type { ToolResult } from '../../shared/ipc/agent-runtime'
import type { ChatTodoItem } from '../../shared/ipc/llm'
import { cloneTodos } from './chat-todo'
import type { JanusAgentMessage } from '@janus-agent/agent-core'

const DEFAULT_CONTEXT_WINDOW = 16_384
const DEFAULT_RESERVED_OUTPUT_TOKENS = 2_048
const SAFETY_MARGIN_TOKENS = 512
const MAX_LOADED_FILES = 3
const MAX_LOADED_FILE_CHARS = 6_000
const MAX_TOOL_CONTENT_CHARS = 6_000
const MAX_TOOL_MESSAGE_CHARS = 4_000
/** Tool output is truncated per result before it enters a summary call. */
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = 2_000
/** Head text is capped so the summary call itself cannot overflow. */
const COMPACTION_MAX_HEAD_CHARS = 24_000
/** Stored summaries stay re-readable at a glance and cheap to resend. */
const COMPACTION_MAX_SUMMARY_CHARS = 8_000
const DEFAULT_COMPACTION_KEEP_UNITS = 1
const MIN_COMPACTION_KEEP_UNITS = 1
const MAX_COMPACTION_KEEP_UNITS = 50

/** One-shot LLM call behind compaction; hosts inject the real transport. */
export type CompactionSummarizer = (
  input: { system?: string; prompt: string },
  signal: AbortSignal,
) => Promise<string>

/** Sections a summary must contain, else the call is retried once. */
export const REQUIRED_SUMMARY_HEADINGS = ['## Goal', '## Progress', '## Next Steps'] as const

const COMPACTION_SYSTEM_PROMPT = [
  'You compress agent conversation context into a handoff note.',
  'Write notes-to-self for the agent that continues the work: resume, never redo completed work.',
  'Keep exact file paths, identifiers, commands, and error strings verbatim.',
  'Never invent sha hashes, and never rewrite paths seen in <conversation>.',
].join(' ')

const COMPACTION_TEMPLATE = [
  '## Goal',
  '[what the user is trying to accomplish, or "(none)"]',
  '',
  '## Constraints & Preferences',
  '[requirements mentioned by the user, or "(none)"]',
  '',
  '## Progress',
  '### Done',
  '- [x] [completed work, or "(none)"]',
  '',
  '### In Progress',
  '- [ ] [current work, or "(none)"]',
  '',
  '### Blocked',
  '- [blockers, or "(none)"]',
  '',
  '## Key Decisions',
  '- **[decision]**: [rationale, or "(none)"]',
  '',
  '## Next Steps',
  '1. [immediate concrete action, or "(none)"]',
  '',
  '## Critical Context',
  '- [data needed to continue, or "(none)"]',
  '',
  '## Relevant Files',
  '- [path: why it matters, or "(none)"]',
].join('\n')

interface LoadedContextEntry {
  workspaceId: string
  path: string
  offset: number
  bytes: number
  truncated: boolean
  sha256: string
  content: string
  size: number
  loadedAt: number
  stale: boolean
}

interface ToolOutput {
  workspaceId?: unknown
  path?: unknown
  sha256?: unknown
  size?: unknown
  content?: unknown
  offset?: unknown
  bytes?: unknown
  truncated?: unknown
  changedPaths?: unknown
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4)
}

function bounded(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: `${value.slice(0, maxChars)}\n[truncated]`, truncated: true }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function toolOutput(result: ToolResult): ToolOutput | undefined {
  return asRecord(result.output) as ToolOutput | undefined
}

export class LoadedContextIndex {
  private readonly entries = new Map<string, LoadedContextEntry>()

  record(result: ToolResult): void {
    const output = toolOutput(result)
    if (!output) return
    if (result.toolName === 'workspace.read' && result.status === 'completed'
      && typeof output.workspaceId === 'string' && typeof output.path === 'string'
      && typeof output.sha256 === 'string' && typeof output.content === 'string') {
      const content = bounded(output.content, MAX_LOADED_FILE_CHARS)
      const offset = typeof output.offset === 'number' ? output.offset : 0
      const bytes = typeof output.bytes === 'number' ? output.bytes : output.content.length
      const key = `${output.workspaceId}:${output.path}:${offset}`
      this.entries.set(key, {
        workspaceId: output.workspaceId,
        path: output.path,
        offset,
        bytes,
        truncated: output.truncated === true || content.truncated,
        sha256: output.sha256,
        content: content.value,
        size: typeof output.size === 'number' ? output.size : output.content.length,
        loadedAt: Date.now(),
        stale: false,
      })
      return
    }

    if (result.status !== 'completed') return
    const changedPaths = Array.isArray(output.changedPaths) ? output.changedPaths : []
    const workspaceId = typeof output.workspaceId === 'string' ? output.workspaceId : result.workspaceId
    for (const path of changedPaths) {
      if (typeof path !== 'string') continue
      for (const entry of this.entries.values()) {
        if (entry.workspaceId === workspaceId && entry.path === path) entry.stale = true
      }
    }
  }

  asSystemMessage(remainingTokens: number): JanusAgentMessage | undefined {
    const eligible = [...this.entries.values()]
      .filter((entry) => !entry.stale)
      .sort((left, right) => right.loadedAt - left.loadedAt)
      .slice(0, MAX_LOADED_FILES)
    if (eligible.length === 0 || remainingTokens < 64) return undefined

    const sections: string[] = []
    let usedTokens = 0
    for (const entry of eligible) {
      const header = [
        `Loaded workspace evidence: ${entry.workspaceId}/${entry.path}`,
        `range=${entry.offset}-${entry.offset + entry.bytes}; sha256=${entry.sha256}; size=${entry.size};${entry.truncated ? ' truncated;' : ''} read again when a newer range is needed.`,
      ].join('\n')
      const availableChars = Math.max(0, (remainingTokens - usedTokens) * 4 - header.length - 1)
      if (availableChars < 128) continue
      const content = bounded(entry.content, Math.min(MAX_LOADED_FILE_CHARS, availableChars)).value
      const section = `${header}\n${content}`
      const cost = estimateTokens(section)
      if (usedTokens + cost > remainingTokens) continue
      sections.push(section)
      usedTokens += cost
    }
    return sections.length ? { role: 'system', content: sections.join('\n\n') } : undefined
  }
}

function compactToolMessage(message: JanusAgentMessage): JanusAgentMessage {
  if (message.role !== 'tool') return message
  try {
    const value = JSON.parse(message.content) as unknown
    const output = asRecord(value)
    if (output && typeof output.content === 'string') {
      const content = bounded(output.content, MAX_TOOL_CONTENT_CHARS)
      return {
        ...message,
        content: JSON.stringify({
          ...output,
          content: content.value,
          ...(content.truncated ? { truncated: true, guidance: 'Use workspace.read again for another range.' } : {}),
        }),
      }
    }
  } catch {
    // Non-JSON tool output is still bounded below.
  }
  return { ...message, content: bounded(message.content, MAX_TOOL_MESSAGE_CHARS).value }
}

function toolDigest(message: JanusAgentMessage): string | undefined {
  if (message.role !== 'tool') return undefined
  const label = message.toolName ?? 'tool'
  let parsed: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(message.content) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    parsed = undefined
  }
  const workspaceId = typeof parsed?.workspaceId === 'string' ? String(parsed.workspaceId) : ''
  const scope = workspaceId ? `${workspaceId} ` : ''
  if (parsed) {
    if (Array.isArray(parsed.entries)) {
      const path = typeof parsed.path === 'string' && parsed.path ? parsed.path : '.'
      return `- ${label} ${scope}${path}: ${String(parsed.entries.length)} entries${parsed.truncated === true ? ' (truncated)' : ''}`
    }
    if (Array.isArray(parsed.matches)) {
      const query = typeof parsed.query === 'string' ? `"${String(parsed.query).slice(0, 80)}"` : ''
      const head = (parsed.matches as Array<{ path?: unknown; line?: unknown }>)
        .slice(0, 5)
        .map((match) => typeof match.path === 'string' ? `${match.path}${typeof match.line === 'number' ? `#L${match.line}` : ''}` : undefined)
        .filter((item): item is string => !!item)
        .join(', ')
      return `- ${label} ${scope}${query}: ${String(parsed.matches.length)} matches${head ? ` (${head})` : ''}${parsed.truncated === true ? ' (truncated)' : ''}`
    }
    if (typeof parsed.content === 'string' && typeof parsed.path === 'string') {
      const sha = typeof parsed.sha256 === 'string' ? ` sha256=${String(parsed.sha256).slice(0, 12)}…` : ''
      return `- ${label} ${scope}${String(parsed.path)}${sha} (content retained in loaded evidence when available)`
    }
    // workspace.delete results carry path + kind/entryCount instead of content:
    // keep a one-line digest so pruned turns still show what was removed.
    if (typeof parsed.path === 'string' && (typeof parsed.kind === 'string' || typeof parsed.entryCount === 'number')) {
      const kind = typeof parsed.kind === 'string' ? String(parsed.kind) : 'target'
      const size = typeof parsed.entryCount === 'number' && parsed.entryCount > 0
        ? `${String(parsed.entryCount)} entries`
        : typeof parsed.bytes === 'number' && parsed.bytes > 0
          ? `${String(parsed.bytes)}b`
          : 'empty'
      return `- ${label} ${scope}${String(parsed.path)} (${kind}, ${size})`
    }
    if (typeof parsed.error === 'string') {
      return `- ${label} ${scope}${parsed.status ?? 'failed'}: ${String(parsed.error).slice(0, 160)}`
    }
    if (typeof parsed.status === 'string' && parsed.status !== 'completed') {
      return `- ${label} ${scope}${String(parsed.status)}`
    }
  }
  const fallback = message.content.length > 160 ? `${message.content.slice(0, 160)}…` : message.content
  return `- ${label} ${scope}${fallback}`
}

/**
 * pi-inspired deterministic handoff (no extra LLM call): when old turn units
 * are pruned to fit the budget, keep exact digests (paths/hashes/queries)
 * instead of dropping them silently. Unlike pi's LLM summary this never
 * paraphrases hashes, so workspace.edit expectedHash stays valid.
 */
export function droppedTurnsHandoffMessage(dropped: JanusAgentMessage[][]): JanusAgentMessage | undefined {
  const lines = dropped.flatMap((unit) => unit.map(toolDigest).filter((line): line is string => !!line))
  if (lines.length === 0) return undefined
  const boundedLines = lines.slice(-24)
  return {
    role: 'system',
    content: [
      `Older workspace evidence (${lines.length} tool results) was pruned to fit the context budget.`,
      'Continue from these digests instead of re-listing blindly. Re-read a file before editing it.',
      ...boundedLines,
    ].join('\n'),
  }
}
function agentTurnUnits(messages: JanusAgentMessage[]): JanusAgentMessage[][] {
  const units: JanusAgentMessage[][] = []
  for (let index = messages.length - 1; index >= 0;) {
    if (messages[index].role !== 'tool') {
      units.push([messages[index]])
      index -= 1
      continue
    }
    const end = index + 1
    while (index >= 0 && messages[index].role === 'tool') index -= 1
    const start = index >= 0 && messages[index].role === 'assistant' && messages[index].toolCalls?.length
      ? index
      : index + 1
    units.push(messages.slice(start, end))
    index = start - 1
  }
  return units
}

function truncateHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[truncated]`
}

function fingerprint(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = (((hash << 5) + hash + value.charCodeAt(index)) | 0)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Serializes turn units for a summary call so the model cannot mistake them
 * for a live conversation: tool calls stay glued to their results (units are
 * never split), and each result is truncated to keep the call bounded.
 */
export function serializeConversationUnits(units: JanusAgentMessage[][]): string {
  const blocks: string[] = []
  for (const unit of units) {
    for (const message of unit) {
      if (message.role === 'user') {
        blocks.push(`[User]: ${message.content}`)
      } else if (message.role === 'assistant') {
        if (message.content) blocks.push(`[Assistant]: ${message.content}`)
        for (const call of message.toolCalls ?? []) {
          blocks.push(`[Assistant tool call]: ${call.name}(${JSON.stringify(call.arguments)})`)
        }
      } else if (message.role === 'tool') {
        blocks.push(`[Tool result]: ${truncateHead(message.content, COMPACTION_TOOL_OUTPUT_MAX_CHARS)}`)
      } else {
        blocks.push(`[System update]: ${message.content}`)
      }
    }
  }
  return blocks.join('\n')
}

export function isValidCompactionSummary(text: string): boolean {
  if (!text.trim()) return false
  return REQUIRED_SUMMARY_HEADINGS.every((heading) => text.includes(heading))
}

export function buildCompactionPrompt(
  previousSummary: string | undefined,
  conversationText: string,
): { system: string; prompt: string } {
  const parts = [`<conversation>\n${conversationText}\n</conversation>`]
  if (previousSummary) {
    parts.push(
      `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      + 'The <previous-summary> is discarded after this call: carry every still-relevant fact into the new summary.',
    )
  }
  parts.push(
    previousSummary
      ? 'Update the summary with the new conversation. Move finished items from In Progress to Done.'
      : 'Summarize the conversation so another agent can continue the work.',
    'Keep every section of this exact structure, in order:',
    COMPACTION_TEMPLATE,
  )
  return { system: COMPACTION_SYSTEM_PROMPT, prompt: parts.join('\n\n') }
}

function budgetFor(model: Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'> | undefined): number {
  const contextWindow = model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const reservedOutput = Math.min(model?.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS)
  return contextWindow - reservedOutput - SAFETY_MARGIN_TOKENS
}

interface ContextLayout {
  systems: JanusAgentMessage[]
  evidence: JanusAgentMessage | undefined
  /** Newest-first turn units; tool calls never split from their results. */
  units: JanusAgentMessage[][]
  /** Units that exceed the budget, newest-first; empty when all fit. */
  dropped: JanusAgentMessage[][]
  usedTokens: number
  budget: number
}

function layoutContext(
  runtime: LoadedContextIndex,
  messages: JanusAgentMessage[],
  options: ChatContextBuildOptions,
): ContextLayout {
  const budget = budgetFor(options.model)
  const systems = messages.filter((message) => message.role === 'system')
  const systemTokens = systems.reduce((total, message) => total + estimateTokens(message.content), 0)
  if (systemTokens >= budget) throw new Error('SYSTEM_CONTEXT_EXCEEDS_BUDGET')

  let usedTokens = systemTokens
  const evidence = runtime.asSystemMessage(Math.max(0, budget - usedTokens))
  if (evidence) usedTokens += estimateTokens(evidence.content)

  const units = agentTurnUnits(messages.filter((message) => message.role !== 'system'))
  const dropped: JanusAgentMessage[][] = []
  let keptCount = 0
  for (const unit of units) {
    const compacted = unit.map(compactToolMessage)
    const unitTokens = compacted.reduce((total, message) => total + estimateTokens(message.content), 0)
    if (usedTokens + unitTokens > budget) {
      if (keptCount === 0) throw new Error('CURRENT_TURN_EXCEEDS_CONTEXT_BUDGET')
      dropped.push(unit)
      continue
    }
    usedTokens += unitTokens
    keptCount += 1
  }
  return { systems, evidence, units, dropped, usedTokens, budget }
}

export interface ChatContextBuildOptions {
  model?: Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'>
}

export interface CompactionOptions extends ChatContextBuildOptions {
  /** Ignore the budget and compact everything but the newest units. */
  force?: boolean
  /** Newest units kept verbatim in force mode, clamped to 1..50. */
  keepRecentUnits?: number
}

// Note: single-summary LLM compaction absorbs evicted turns — see ../../../../../.agents/notes/implemented/feature/2026-09-12-llm-compaction-loop.md

/** Builds a model context view without mutating the persisted conversation history. */
export class ChatSessionRuntime {
  readonly loadedContext = new LoadedContextIndex()
  private todos: ChatTodoItem[] = []
  private summary: string | null = null
  private summaryKey: string | null = null

  /** Live todo list for the sticky bar above the composer (model is sole writer). */
  getTodos(): ChatTodoItem[] {
    return cloneTodos(this.todos)
  }

  setTodos(todos: readonly ChatTodoItem[]): void {
    this.todos = cloneTodos(todos)
  }

  clearTodos(): void {
    this.todos = []
  }

  recordToolResult(result: ToolResult): void {
    this.loadedContext.record(result)
  }

  getSummary(): string | null {
    return this.summary
  }

  /** Persisted state round-trip: summary text plus the head key it absorbed. */
  getCompactionState(): { summary: string; key: string } | null {
    if (!this.summary || !this.summaryKey) return null
    return { summary: this.summary, key: this.summaryKey }
  }

  setCompactionState(summary: string | null, key: string | null): void {
    this.summary = summary && summary.trim() ? summary : null
    this.summaryKey = this.summary && key ? key : null
    if (!this.summary) this.summaryKey = null
  }

  private summaryMessage(): JanusAgentMessage {
    return {
      role: 'user',
      content: [
        '[Compacted context — earlier history was summarized to free budget. Resume from it; do not redo completed work.]',
        '',
        this.summary ?? '',
      ].join('\n'),
    }
  }

  /**
   * Summarizes the evicted head once per unseen content and stores a single
   * summary. Auto mode compacts only budget-dropped units; force mode
   * compacts everything but the newest units regardless of budget. Never
   * throws: a failed summary falls back to the deterministic digest path.
   */
  async maybeCompact(
    messages: JanusAgentMessage[],
    options: CompactionOptions,
    summarize: CompactionSummarizer,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    try {
      let layout: ContextLayout
      try {
        layout = layoutContext(this.loadedContext, messages, options)
      } catch {
        return false
      }
      const keep = Math.min(
        MAX_COMPACTION_KEEP_UNITS,
        Math.max(MIN_COMPACTION_KEEP_UNITS, Math.floor(options.keepRecentUnits ?? DEFAULT_COMPACTION_KEEP_UNITS)),
      )
      const head = options.force ? layout.units.slice(keep) : layout.dropped
      if (head.length === 0) return false
      const headText = serializeConversationUnits(head.slice().reverse())
      const boundedHead = headText.length > COMPACTION_MAX_HEAD_CHARS
        ? `[earliest evicted history omitted for the summary call]\n${headText.slice(-COMPACTION_MAX_HEAD_CHARS)}`
        : headText
      // Content-addressed on the head alone: mixing the previous summary
      // into the key would change it on every store and never hit twice.
      const key = fingerprint(boundedHead)
      if (key === this.summaryKey) return false

      const { system, prompt } = buildCompactionPrompt(this.summary ?? undefined, boundedHead)
      let text = await summarize({ system, prompt }, signal)
      if (!isValidCompactionSummary(text)) {
        text = await summarize({
          system,
          prompt: `${prompt}\n\nYour previous response missed required sections (${REQUIRED_SUMMARY_HEADINGS.join(', ')}). Reply with the full structure and nothing else.`,
        }, signal)
        if (!isValidCompactionSummary(text)) return false
      }
      const bounded = text.length > COMPACTION_MAX_SUMMARY_CHARS
        ? `${text.slice(0, COMPACTION_MAX_SUMMARY_CHARS)}\n[truncated]`
        : text
      this.summary = bounded
      this.summaryKey = key
      return true
    } catch {
      return false
    }
  }

  buildContext(messages: JanusAgentMessage[], options: ChatContextBuildOptions = {}): JanusAgentMessage[] {
    const layout = layoutContext(this.loadedContext, messages, options)
    const droppedSet = new Set(layout.dropped)
    const keptChrono = layout.units.filter((unit) => !droppedSet.has(unit)).reverse()

    const context = [...layout.systems]
    if (layout.evidence) context.push(layout.evidence)
    if (this.summary) context.push(this.summaryMessage())
    for (const unit of keptChrono) context.push(...unit.map(compactToolMessage))
    let usedTokens = layout.usedTokens + (this.summary ? estimateTokens(this.summary) : 0)
    // Summarize everything pruned so exploration is not silently lost.
    // pi uses an LLM summary here; we use exact digests to keep sha256 usable.
    if (layout.dropped.length > 0) {
      const handoff = droppedTurnsHandoffMessage(layout.dropped)
      if (handoff) {
        const handoffTokens = estimateTokens(handoff.content)
        const at = layout.systems.length + (layout.evidence ? 1 : 0) + (this.summary ? 1 : 0)
        if (usedTokens + handoffTokens <= layout.budget) {
          context.splice(at, 0, handoff)
          usedTokens += handoffTokens
        } else {
          // Budget too tight for the full digest: keep a truncated head note
          // rather than dropping exploration entirely.
          const head = bounded(handoff.content, Math.max(256, (layout.budget - usedTokens) * 4 - 64))
          if (usedTokens + estimateTokens(head.value) <= layout.budget) {
            context.splice(at, 0, { role: 'system', content: head.value })
          }
        }
      }
    }
    return context
  }
}
