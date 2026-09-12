/**
 * @file Built-in model context-window lookup for the janus CLI.
 * @description Framework-agnostic, no IO. The CLI ships OpenAI-compatible
 * transports with no window metadata, so `ChatSessionRuntime.buildContext`
 * always fell back to 16384 tokens even for 1M-token models. Rows live in
 * `./model-limits.table.ts` (curated, longest-prefix wins); unknown ids get
 * a conservative fallback flagged as estimated. Precedence per call:
 * config override > built-in row > fallback. Values stay conservative
 * (small) on doubt: guessing low only compacts early, guessing high
 * overflows the provider.
 *
 * Note: why a checked-in table instead of adaptive learning or live
 * discovery — see .agents/notes/implemented/feature/2026-09-12-model-window-table.md
 */
import { MODEL_LIMIT_ROWS } from './model-limits.table.js'

export interface ModelLimits {
  contextWindow: number
  maxOutputTokens: number
}

export type ModelLimitSource = 'override' | 'builtin' | 'fallback'

export interface ResolvedModelLimits {
  limits: ModelLimits
  source: ModelLimitSource
  /** True only for fallback: the value is a guess, surface it as such. */
  estimated: boolean
}

/** Matches `ChatSessionRuntime` defaults: unknown models change nothing. */
export const FALLBACK_MODEL_LIMITS: ModelLimits = {
  contextWindow: 16_384,
  maxOutputTokens: 2_048,
}

interface FamilyEntry {
  /** Lowercase id prefix, e.g. 'gpt-4o' matches 'gpt-4o' and 'gpt-4o-mini'. */
  prefix: string
  limits: ModelLimits
}

// Curated rows, longest prefix first so specific SKUs beat families
// (`kimi-k3` beats `kimi-k2`, `o1-mini` beats `o1`).
const FAMILIES: FamilyEntry[] = MODEL_LIMIT_ROWS
  .map((row) => ({
    prefix: row.prefix,
    limits: { contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens },
  }))
  .sort((a, b) => b.prefix.length - a.prefix.length)

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function resolveModelLimits(input: {
  modelId?: string
  override?: { contextWindow?: unknown; maxOutputTokens?: unknown }
}): ResolvedModelLimits {
  const overrideWindow = positive(input.override?.contextWindow)
  const overrideOutput = positive(input.override?.maxOutputTokens)
  const id = (input.modelId ?? '').trim().toLowerCase()

  const builtin = FAMILIES.find((entry) => id.startsWith(entry.prefix))
  const base = builtin?.limits ?? FALLBACK_MODEL_LIMITS
  if (overrideWindow !== undefined || overrideOutput !== undefined) {
    return {
      limits: {
        contextWindow: overrideWindow ?? base.contextWindow,
        maxOutputTokens: overrideOutput ?? base.maxOutputTokens,
      },
      source: 'override',
      estimated: false,
    }
  }
  if (builtin) return { limits: { ...builtin.limits }, source: 'builtin', estimated: false }
  return { limits: { ...FALLBACK_MODEL_LIMITS }, source: 'fallback', estimated: true }
}
