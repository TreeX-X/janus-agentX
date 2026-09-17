import type { ModelInfo } from '../../shared/ipc/model-types'
import type { ToolResult } from '../../shared/ipc/agent-runtime'
import type { ChatTodoItem } from '../../shared/ipc/llm'
import { cloneTodos } from './chat-todo'
import type { JanusAgentMessage } from '@janus-agent/agent-core'

const DEFAULT_CONTEXT_WINDOW = 16_384
const DEFAULT_RESERVED_OUTPUT_TOKENS = 2_048
const SAFETY_MARGIN_TOKENS = 512
/** User tuning may only move the trigger earlier, never past this share of the window. */
const MAX_COMPACTION_THRESHOLD_RATIO = 0.9
const MAX_LOADED_FILES = 3
/** Tool output is truncated per result before it enters a summary call. */
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = 2_000
/** Head text is capped so the summary call itself cannot overflow. */
const COMPACTION_MAX_HEAD_CHARS = 24_000
/** Stored summaries stay re-readable at a glance and cheap to resend. */
const COMPACTION_MAX_SUMMARY_CHARS = 6_000
/** Prune tier: newest tool outputs stay verbatim within this tail budget; older ones keep the call and a digest. */
const DEFAULT_PRUNE_KEEP_TOKENS = 16_000
const MIN_PRUNE_KEEP_TOKENS = 4_000
const DEFAULT_COMPACTION_KEEP_UNITS = 1
const MIN_COMPACTION_KEEP_UNITS = 1
const MAX_COMPACTION_KEEP_UNITS = 50

/** Provider overflow signals that survive transport normalization. */
const CONTEXT_OVERFLOW_PATTERN = /context|overflow|too large|too_long|token.*limit|limit.*token|413|431/i

/** True for provider-side context exhaustion (retryable once after a forced compact). */
export function isContextOverflowError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return CONTEXT_OVERFLOW_PATTERN.test(text)
}

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
  lineEnd?: number
  totalLines?: number
  nextOffset?: number
  truncated: boolean
  sha256: string
  size: number
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
  lineEnd?: unknown
  totalLines?: unknown
  nextOffset?: unknown
  truncated?: unknown
  changedPaths?: unknown
}

/** Conservative estimate until provider usage is available; CJK is not four chars/token. */
export function estimateContextTokens(value: string): number {
  const nonAscii = value.match(/[^\x00-\x7f]/gu)?.length ?? 0
  return Math.ceil((value.length - nonAscii) / 4 + nonAscii)
}
const estimateTokens = estimateContextTokens

function messageTokens(message: JanusAgentMessage): number {
  return 4 + estimateTokens(message.content)
    + (message.toolCalls ? estimateTokens(JSON.stringify(message.toolCalls)) : 0)
    + estimateTokens(message.toolName ?? '')
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
      const offset = typeof output.offset === 'number' ? output.offset : 1
      const bytes = typeof output.bytes === 'number' ? output.bytes : output.content.length
      const lineEnd = typeof output.lineEnd === 'number' ? output.lineEnd : undefined
      const totalLines = typeof output.totalLines === 'number' ? output.totalLines : undefined
      const nextOffset = typeof output.nextOffset === 'number' ? output.nextOffset : undefined
      const key = `${output.workspaceId}:${output.path}:${offset}`
      for (const entry of this.entries.values()) {
        if (entry.workspaceId === output.workspaceId && entry.path === output.path && entry.sha256 !== output.sha256) entry.stale = true
      }
      this.entries.delete(key)
      this.entries.set(key, {
        workspaceId: output.workspaceId,
        path: output.path,
        offset,
        bytes,
        lineEnd,
        totalLines,
        nextOffset,
        truncated: output.truncated === true,
        sha256: output.sha256,
        size: typeof output.size === 'number' ? output.size : output.content.length,
        stale: false,
      })
      while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!)
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

  /** Metadata only: file bodies belong to their tool messages, never a moving prefix. */
  asSystemMessage(remainingTokens: number, visible: string = ''): JanusAgentMessage | undefined {
    const lines = [...this.entries.values()].filter((entry) => !entry.stale && !visible.includes(JSON.stringify(entry.sha256))).slice(-MAX_LOADED_FILES)
      .map((entry) => `Loaded workspace evidence: ${entry.workspaceId}/${entry.path}; sha256=${entry.sha256}; lines=${entry.offset}-${entry.lineEnd ?? '?'}/${entry.totalLines ?? '?'};${entry.nextOffset ? ` next offset=${entry.nextOffset};` : ''} re-read the needed range if its tool result is absent.`)
    const selected: string[] = []
    for (const line of lines) {
      if (estimateTokens([...selected, line].join('\n')) + 4 > remainingTokens) break
      selected.push(line)
    }
    return selected.length ? { role: 'system', content: selected.join('\n') } : undefined
  }

}


/**
 * opencode-style prune: the assistant tool_call is always retained, but a
 * stale tool_output body is replaced by a one-line digest placeholder. The
 * digest (paths/hashes/queries) is what handoff and traces already carry, so
 * no evidence is lost — only the bulky verbatim blob is erased.
 */
function pruneToolMessage(message: JanusAgentMessage): JanusAgentMessage {
  if (message.role !== 'tool') return message
  const digest = toolDigest(message) ?? `- ${message.toolName ?? 'tool'}`
  return {
    ...message,
    content: JSON.stringify({
      pruned: true,
      digest,
      guidance: 'Output pruned to save context; the call above is retained. Re-read the file or re-run the query when verbatim content is needed.',
    }),
  }
}

function firstGroupHit(group: Record<string, unknown>): number | undefined {
  const hunks = group.hunks
  if (!Array.isArray(hunks)) return undefined
  for (const hunk of hunks) {
    const lines = (hunk as Record<string, unknown>)?.lines
    if (!Array.isArray(lines)) continue
    for (const entry of lines) {
      const record = (entry ?? {}) as Record<string, unknown>
      if (record.hit === true && typeof record.line === 'number') return record.line
    }
  }
  return undefined
}

function toolDigest(message: JanusAgentMessage): string | undefined {
  if (message.role !== 'tool') return undefined
  const label = message.toolName ?? 'tool'
  // Plain-text model values (opencode parity): first line already carries
  // the digest (e.g. `Found 3 matches for "q"`, `<path>a.ts</path> lines
  // 1-200/1000 sha=…`, `$ npm run build exit=1`, `Edited a.ts sha=…`).
  const firstLine = message.content.split('\n', 1)[0]?.trim() ?? ''
  if (!message.content.trimStart().startsWith('{')) {
    const head = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine
    if (head) return `- ${label} ${head}`
  }
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
      const head = (parsed.matches as Array<Record<string, unknown>>)
        .slice(0, 5)
        .map((match) => {
          if (typeof match.path !== 'string') return undefined
          // Content-mode file groups point at their first hit line; flat
          // files-mode matches and legacy shapes keep path[#Lline].
          const line = typeof match.line === 'number' ? match.line : firstGroupHit(match)
          return `${match.path}${typeof line === 'number' ? `#L${line}` : ''}`
        })
        .filter((item): item is string => !!item)
        .join(', ')
      const hits = (parsed.matches as Array<Record<string, unknown>>)
        .reduce((total, match) => total + (typeof match.matchCount === 'number' ? match.matchCount : 1), 0)
      return `- ${label} ${scope}${query}: ${String(hits)} matches${head ? ` (${head})` : ''}${parsed.truncated === true ? ' (truncated)' : ''}`
    }
    if (typeof parsed.content === 'string' && typeof parsed.path === 'string') {
      const sha = typeof parsed.sha256 === 'string' ? ` sha256=${String(parsed.sha256).slice(0, 12)}…` : ''
      const range = typeof parsed.lineStart === 'number' && typeof parsed.lineEnd === 'number'
        ? ` L${String(parsed.lineStart)}-${String(parsed.lineEnd)}${typeof parsed.totalLines === 'number' ? `/${String(parsed.totalLines)}` : ''}`
        : ''
      return `- ${label} ${scope}${String(parsed.path)}${range}${sha} (re-read this range if needed)`
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
  focus?: string,
): { system: string; prompt: string } {
  const parts = [`<conversation>\n${conversationText}\n</conversation>`]
  if (previousSummary) {
    parts.push(
      `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      + 'The <previous-summary> is discarded after this call: carry every still-relevant fact into the new summary.',
    )
  }
  if (focus?.trim()) {
    parts.push(`Additional focus from the user (emphasize, do not drop other sections):\n${focus.trim().slice(0, 500)}`)
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

/** Code-side file ledger: exact paths the LLM must not paraphrase. */
export interface CompactionFileRefs {
  readFiles: string[]
  modifiedFiles: string[]
}

const MAX_FILE_REFS_PER_KIND = 20

function collectFileRefs(head: JanusAgentMessage[][]): CompactionFileRefs {
  const read = new Set<string>()
  const modified = new Set<string>()
  const take = (value: unknown, into: Set<string>) => {
    if (typeof value !== 'string') return
    const path = value.trim().slice(0, 200)
    if (path) into.add(path)
  }
  for (const unit of head) {
    for (const message of unit) {
      for (const call of message.toolCalls ?? []) {
        const args = asRecord(call.arguments)
        const name = call.name.toLowerCase()
        if (name.includes('read')) take(args?.path, read)
        if (name.includes('edit') || name.includes('write') || name.includes('delete')) take(args?.path, modified)
      }
      if (message.role !== 'tool') continue
      try {
        const parsed = asRecord(JSON.parse(message.content))
        take(parsed?.path, read)
        for (const changed of Array.isArray(parsed?.changedPaths) ? parsed?.changedPaths as unknown[] : []) {
          take(changed, modified)
        }
      } catch {
        // Non-JSON tool output carries no file refs.
      }
    }
  }
  return {
    readFiles: [...read].slice(0, MAX_FILE_REFS_PER_KIND),
    modifiedFiles: [...modified].slice(0, MAX_FILE_REFS_PER_KIND),
  }
}

function formatFileRefs(refs: CompactionFileRefs): string {
  const lines: string[] = []
  if (refs.readFiles.length > 0) {
    lines.push('', 'Read files (exact paths, re-read before editing):')
    for (const path of refs.readFiles) lines.push(`- ${path}`)
  }
  if (refs.modifiedFiles.length > 0) {
    lines.push('', 'Modified files (exact paths):')
    for (const path of refs.modifiedFiles) lines.push(`- ${path}`)
  }
  return lines.join('\n')
}

function budgetFor(
  model: Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'> | undefined,
  bufferOverride?: number,
): number {
  const contextWindow = model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const reservedOutput = Math.min(model?.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS)
  const buffer = Number.isSafeInteger(bufferOverride)
    ? Math.min(Math.max(bufferOverride as number, 0), Math.floor(contextWindow * (1 - MAX_COMPACTION_THRESHOLD_RATIO)))
    : SAFETY_MARGIN_TOKENS
  // Hard ceiling: callers may move the trigger earlier via buffer, never past
  // 90% of the window, so a late threshold cannot overflow the provider.
  return Math.min(contextWindow - reservedOutput - buffer, Math.floor(contextWindow * MAX_COMPACTION_THRESHOLD_RATIO))
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
  /** Full usable window before summary reservation; budget = window - reserved. */
  window: number
}

// Note: preserve current evidence and prune before summarizing — see .agents/notes/implemented/bug-fix/2026-09-16-agent-context-search-efficiency.md
// Note: graded prune (opencode parity) — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
// Search/list/overview outputs are cheap to re-run (one rg passthrough), so
// only their newest 2 turns stay verbatim; reads/edits/command evidence keep
// the full pruneKeep tail because re-reads cost a turn each.

/** Search/list/overview units are disposable: re-running them is one cheap call. */
const DISPOSABLE_TOOL_NAMES = new Set([
  'workspace_search', 'workspace.search',
  'workspace_list', 'workspace.list',
  'workspace_overview', 'workspace.overview',
])

/** Disposable units keep verbatim bodies only within this many newest turns. */
const DISPOSABLE_VERBATIM_TURNS = 2

function unitIsDisposable(unit: JanusAgentMessage[]): boolean {
  let sawTool = false
  for (const message of unit) {
    if (message.role === 'tool') {
      sawTool = true
      if (!DISPOSABLE_TOOL_NAMES.has(message.toolName ?? '')) return false
    }
    for (const call of message.toolCalls ?? []) {
      sawTool = true
      if (!DISPOSABLE_TOOL_NAMES.has(call.name)) return false
    }
  }
  return sawTool
}

function layoutContext(
  runtime: LoadedContextIndex,
  messages: JanusAgentMessage[],
  options: ChatContextBuildOptions,
  reservedTokens = 0,
): ContextLayout {
  const window = budgetFor(options.model, options.bufferTokens) - (options.toolTokens ?? 0)
  const systems = messages.filter((message) => message.role === 'system')
  const systemTokens = systems.reduce((total, message) => total + messageTokens(message), 0)
  if (systemTokens >= window) throw new Error('SYSTEM_CONTEXT_EXCEEDS_BUDGET')
  const budget = Math.max(0, window - reservedTokens)
  const original = agentTurnUnits(messages.filter((message) => message.role !== 'system'))
  const newestUser = original.findIndex((unit) => unit.some((message) => message.role === 'user'))
  const pruneKeep = Math.max(MIN_PRUNE_KEEP_TOKENS, options.pruneKeepTokens ?? DEFAULT_PRUNE_KEEP_TOKENS)
  let tailTokens = 0
  const units = original.map((unit, index) => {
    const disposable = unitIsDisposable(unit)
    const keep = index === 0
      || (tailTokens < pruneKeep && (!disposable || index < DISPOSABLE_VERBATIM_TURNS))
    tailTokens += unit.reduce((sum, message) => sum + messageTokens(message), 0)
    return keep ? unit : unit.map(pruneToolMessage)
  })
  const cost = (unit: JanusAgentMessage[]) => unit.reduce((sum, message) => sum + messageTokens(message), 0)
  let usedTokens = systemTokens + units.reduce((sum, unit) => sum + cost(unit), 0)
  // Under pressure, prune old tool bodies before evicting any conversation.
  for (let index = units.length - 1; index > 0 && usedTokens > budget; index -= 1) {
    const pruned = units[index].map(pruneToolMessage)
    const saved = cost(units[index]) - cost(pruned)
    if (saved > 0) { usedTokens -= saved; units[index] = pruned }
  }
  const dropped: JanusAgentMessage[][] = []
  for (let index = units.length - 1; index >= 0 && usedTokens > budget; index -= 1) {
    if (index === 0 || index === newestUser) continue
    dropped.unshift(units[index])
    usedTokens -= cost(units[index])
  }
  if (usedTokens > budget && units[0]?.some((message) => message.role === 'tool')) {
    const originalCost = cost(units[0])
    units[0] = units[0].map((message) => message.role !== 'tool' ? message : {
      ...message,
      content: JSON.stringify({
        outputOmitted: true, digest: toolDigest(message),
        guidance: 'This result exceeds the available context budget. Its body is NOT visible. Repeat with a smaller limit/maxBytes/maxResults and the SAME start offset; do not advance to nextOffset.',
      }),
    })
    usedTokens += cost(units[0]) - originalCost
  }
  if (usedTokens > budget) {
    throw new Error('CURRENT_CONTEXT_EXCEEDS_BUDGET: narrow the read/search range or increase the model context window; current user and latest tool evidence cannot be discarded')
  }
  // Optional metadata goes after history and cannot evict useful evidence.
  const visible = units.filter((unit) => !dropped.includes(unit)).flat().filter((message) => message.role === 'tool').map((message) => message.content).join('\n')
  const evidence = runtime.asSystemMessage(Math.max(0, budget - usedTokens), visible)
  if (evidence) usedTokens += messageTokens(evidence)
  return { systems, evidence, units, dropped, usedTokens, budget, window }
}

export interface ChatContextBuildOptions {
  model?: Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'>
  /** Serialized tool schema/description estimate, reserved alongside messages. */
  toolTokens?: number
  /** Safety reserve below the window; clamped to 0..10% so callers tune early only. */
  bufferTokens?: number
  /**
   * Note: prune tail budget — see .agents/notes/implemented/feature/2026-09-15-context-efficiency.md
   * Newest tool outputs stay verbatim within this token tail; older kept units
   * keep the assistant tool_call but have their tool_output replaced by a digest
   * placeholder. Tunable; defaults far above system+tools so short sessions never prune.
   */
  pruneKeepTokens?: number
}

export interface CompactionOptions extends ChatContextBuildOptions {
  /** Ignore the budget and compact everything but the newest units. */
  force?: boolean
  /** Newest units kept verbatim in force mode, clamped to 1..50. */
  keepRecentUnits?: number
  /** Optional manual-compact emphasis; rendered into the summary prompt. */
  focus?: string
}

// Note: single-summary LLM compaction absorbs evicted turns — see ../../../../../.agents/notes/implemented/feature/2026-09-12-llm-compaction-loop.md

/** Builds a model context view without mutating the persisted conversation history. */
export class ChatSessionRuntime {
  readonly loadedContext = new LoadedContextIndex()
  private todos: ChatTodoItem[] = []
  private summary: string | null = null
  private summaryKey: string | null = null
  private lastCompaction: { tokensBefore: number; summaryChars: number } | null = null

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

  /** Observability for /status and logs: pre-compact tokens plus stored summary size. */
  getLastCompactionInfo(): { tokensBefore: number; summaryChars: number } | null {
    return this.lastCompaction ? { ...this.lastCompaction } : null
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

  private summaryCost(): number {
    return this.summary ? messageTokens(this.summaryMessage()) : 0
  }

  /**
   * Summarizes the evicted head and stores a single summary. Auto mode
   * compacts only budget-dropped units; force mode compacts everything but
   * the newest units regardless of budget. Manual callers pass persisted
   * prose history (no tool pairs survive across turns), so their head is
   * prose-only while the in-loop auto path also covers tool units.
   * Iterates (max 3 passes) because
   * reserving the new summary can evict further units, which the next pass
   * absorbs — every dropped unit ends covered. Never throws: a failed
   * summary falls back to the deterministic digest path.
   */
  async maybeCompact(
    messages: JanusAgentMessage[],
    options: CompactionOptions,
    summarize: CompactionSummarizer,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    try {
      const keep = Math.min(
        MAX_COMPACTION_KEEP_UNITS,
        Math.max(MIN_COMPACTION_KEEP_UNITS, Math.floor(options.keepRecentUnits ?? DEFAULT_COMPACTION_KEEP_UNITS)),
      )
      let compacted = false
      for (let pass = 0; pass < 3; pass += 1) {
        let layout: ContextLayout
        try {
          layout = layoutContext(this.loadedContext, messages, options, this.summaryCost())
        } catch {
          return compacted
        }
        const head = options.force ? layout.units.slice(keep) : layout.dropped
        if (head.length === 0) return compacted
        const headText = serializeConversationUnits(head.slice().reverse())
        const boundedHead = headText.length > COMPACTION_MAX_HEAD_CHARS
          ? `[earliest evicted history omitted for the summary call]\n${headText.slice(-COMPACTION_MAX_HEAD_CHARS)}`
          : headText
        // Content-addressed on the full head: the prompt is truncated to keep
        // the call bounded, but the key covers omitted prefixes so distinct
        // histories with the same tail never share a key and lose content.
        // Mixing the previous summary into the key would change it on every
        // store and never hit twice.
        const key = fingerprint(headText)
        if (key === this.summaryKey) return compacted

        const tokensBefore = layout.usedTokens + this.summaryCost()
        const { system, prompt } = buildCompactionPrompt(this.summary ?? undefined, boundedHead, options.focus)
        let text: string
        try {
          text = await summarize({ system, prompt }, signal)
          if (!isValidCompactionSummary(text)) {
            text = await summarize({
              system,
              prompt: `${prompt}\n\nYour previous response missed required sections (${REQUIRED_SUMMARY_HEADINGS.join(', ')}). Reply with the full structure and nothing else.`,
            }, signal)
            if (!isValidCompactionSummary(text)) return compacted
          }
        } catch {
          return compacted
        }
        // File ledger stays code-side so the model never paraphrases paths:
        // exact refs ride below the prose summary on every compact. The prose
        // share yields to the ledger so the stored total stays bounded.
        const ledger = formatFileRefs(collectFileRefs(head))
        const proseBudget = Math.max(1024, COMPACTION_MAX_SUMMARY_CHARS - ledger.length)
        const bounded = text.length > proseBudget
          ? `${text.slice(0, proseBudget)}\n[truncated]`
          : text
        this.summary = `${bounded}${ledger}`
        this.summaryKey = key
        this.lastCompaction = { tokensBefore, summaryChars: this.summary.length }
        compacted = true
      }
      return compacted
    } catch {
      return false
    }
  }

  buildContext(messages: JanusAgentMessage[], options: ChatContextBuildOptions = {}): JanusAgentMessage[] {
    const layout = layoutContext(this.loadedContext, messages, options, this.summaryCost())
    const droppedSet = new Set(layout.dropped)
    const keptChrono = layout.units.filter((unit) => !droppedSet.has(unit)).reverse()

    const context = [...layout.systems]
    if (this.summary) context.push(this.summaryMessage())
    for (const unit of keptChrono) context.push(...unit)
    if (layout.evidence) context.push(layout.evidence)
    let usedTokens = layout.usedTokens + this.summaryCost()
    // Summarize everything pruned so exploration is not silently lost.
    // pi uses an LLM summary here; we use exact digests to keep sha256 usable.
    if (layout.dropped.length > 0) {
      const handoff = droppedTurnsHandoffMessage(layout.dropped)
      if (handoff) {
        const handoffTokens = messageTokens(handoff)
        const at = layout.systems.length + (this.summary ? 1 : 0)
        // Total view is usedTokens (systems+evidence+kept+summary) + handoff
        // and must fit window, not budget: budget already subtracted the
        // summary once, so checking against budget would charge it twice.
        if (usedTokens + handoffTokens <= layout.window) {
          context.splice(at, 0, handoff)
          usedTokens += handoffTokens
        } else {
          // Budget too tight for the full digest: keep a truncated head note
          // rather than dropping exploration entirely.
          const head = bounded(handoff.content, Math.max(256, (layout.window - usedTokens) * 4 - 64))
          if (usedTokens + estimateTokens(head.value) + 4 <= layout.window) {
            context.splice(at, 0, { role: 'system', content: head.value })
          }
        }
      }
    }
    return context
  }
}
