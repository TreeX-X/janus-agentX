/**
 * @file Reasoning-effort levels for the janus CLI (CodeX parity, minimal).
 * @description Pure helpers, no IO. CodeX backend enumerates
 * `none/minimal/low/medium/high/xhigh/max`; the CLI additionally accepts
 * `ultra` and clamps it to `xhigh` on the wire (Muse Code semantics: ultra
 * is client-side delegation, not deeper per-call reasoning).
 * Precedence (mirrors model): flag > JANUS_EFFORT > file default > provider > medium.
 */

/** Backend-accepted levels plus CLI-accepted `ultra`. */
export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const DEFAULT_EFFORT: EffortLevel = 'medium'

/** Lower-case match; undefined when not a known level. */
export function normalizeEffort(value: unknown): EffortLevel | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(trimmed)
    ? (trimmed as EffortLevel)
    : undefined
}

export function effortListText(): string {
  return EFFORT_LEVELS.join('|')
}

/** User-facing metadata for the interactive picker (ordered = wire order). */
export interface EffortMeta {
  id: EffortLevel
  /** Short label shown next to the id. */
  hint: string
  /** One-line tradeoff description (speed/cost intent). */
  detail: string
}

export const EFFORT_META: readonly EffortMeta[] = [
  { id: 'none', hint: 'no reasoning', detail: 'fastest · cheapest · direct answers' },
  { id: 'minimal', hint: 'tiny reasoning', detail: 'quick drafts · trivial edits' },
  { id: 'low', hint: 'light reasoning', detail: 'simple tasks · fast' },
  { id: 'medium', hint: 'balanced (default)', detail: 'general work · default' },
  { id: 'high', hint: 'deep reasoning', detail: 'hard tasks · slower' },
  { id: 'xhigh', hint: 'very deep', detail: 'complex reasoning · costly' },
  { id: 'max', hint: 'backend max', detail: 'slowest · most expensive' },
  { id: 'ultra', hint: 'agentic max', detail: '≈xhigh on wire · delegation' },
]

export function effortMeta(level: EffortLevel): EffortMeta {
  return EFFORT_META.find((meta) => meta.id === level) ?? { id: level, hint: '', detail: '' }
}

/** Numbered rows for pickers: `*` marks current, index is 1-based. */
export function effortPickerRows(current?: string): string[] {
  return EFFORT_META.map((meta, index) => {
    const mark = meta.id === current ? '*' : ' '
    return `${mark} ${index + 1} ${meta.id} — ${meta.hint} (${meta.detail})`
  })
}

/** Multi-line listing used by bare /effort fallbacks (pure, unit tested). */
export function formatEffortList(current: string): string {
  return [`effort: ${current}`, ...effortPickerRows(current), 'switch with /effort <level|number>'].join('\n')
}

export type EffortPickerSelection =
  | { action: 'cancel' }
  | { action: 'switch'; level: EffortLevel }
  | { action: 'error'; message: string }

/**
 * Resolve a single `/effort <arg>` token: level name (case-insensitive)
 * or 1-based picker number. Undefined when neither matches.
 */
export function resolveEffortArg(arg: string): EffortLevel | undefined {
  const trimmed = arg.trim().toLowerCase()
  const asNumber = Number(trimmed)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= EFFORT_META.length) {
    return EFFORT_META[asNumber - 1]?.id
  }
  return normalizeEffort(trimmed)
}

/**
 * Parse one line of picker input (plain loop + tests).
 * Empty/q/Esc = cancel; 1..N = numbered row; otherwise a level name.
 */
export function parseEffortPickerInput(raw: string): EffortPickerSelection {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed === 'q' || trimmed === 'esc' || trimmed === 'cancel') return { action: 'cancel' }
  const asNumber = Number(trimmed)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= EFFORT_META.length) {
    const picked = EFFORT_META[asNumber - 1]
    if (picked) return { action: 'switch', level: picked.id }
  }
  // Allow `/effort 3` style plus plain names (`HIGH`, ` xhigh `).
  const level = normalizeEffort(trimmed)
  if (level) return { action: 'switch', level }
  return { action: 'error', message: `janus: unknown effort "${raw.trim()}". Supported: ${effortListText()} or 1-${EFFORT_META.length}.` }
}

/** Throwing parser for flags and /effort (message mirrors --approval-mode style). */
export function parseEffortOrThrow(value: string, flag = '--effort'): EffortLevel {
  const level = normalizeEffort(value)
  if (!level) throw new Error(`Invalid ${flag}: ${value ?? '(missing)'}. Supported: ${effortListText()}`)
  return level
}

/**
 * Wire value for the model request. `ultra` clamps to `xhigh` so providers
 * never see an unknown string; everything else passes through unchanged.
 */
export function wireEffort(level: EffortLevel): string {
  return level === 'ultra' ? 'xhigh' : level
}

/**
 * AI-SDK `providerOptions` for an OpenAI-compatible endpoint. Namespaced
 * under `openai` so custom transports can forward it verbatim; hosts that
 * stub `streamTextFn` simply ignore the extra field.
 */
export function effortProviderOptions(level: EffortLevel): {
  providerOptions: Record<string, Record<string, string>>
} {
  return { providerOptions: { openai: { reasoningEffort: wireEffort(level) } } }
}
