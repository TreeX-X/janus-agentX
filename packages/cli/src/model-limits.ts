/**
 * @file Built-in model context-window table for the janus CLI.
 * @description Framework-agnostic, no IO. The CLI ships OpenAI-compatible
 * transports with no window metadata, so `ChatSessionRuntime.buildContext`
 * always fell back to 16384 tokens even for 1M-token models. This table
 * gives known families their documented window; unknown ids get a
 * conservative fallback flagged as estimated. Precedence per call:
 * config override > built-in family > fallback. Values stay conservative
 * (small) on doubt: guessing low only compacts early, guessing high
 * overflows the provider.
 *
 * Refresh pointer: values mirror models.dev / provider docs at seed time.
 * Regenerate by hand from those sources; no runtime fetch by design.
 *
 * Note: why a checked-in table instead of adaptive learning or live
 * discovery — see .agents/notes/implemented/feature/2026-09-12-model-window-table.md
 */

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

// Curated seed, conservative on doubt. Families only; per-SKU exceptions
// get their own longer prefix when one is ever needed.
const FAMILIES: FamilyEntry[] = [
  { prefix: 'gpt-4.1', limits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 } },
  { prefix: 'gpt-4o', limits: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { prefix: 'gpt-5', limits: { contextWindow: 400_000, maxOutputTokens: 32_768 } },
  { prefix: 'o1', limits: { contextWindow: 200_000, maxOutputTokens: 100_000 } },
  { prefix: 'o3', limits: { contextWindow: 200_000, maxOutputTokens: 100_000 } },
  { prefix: 'claude', limits: { contextWindow: 200_000, maxOutputTokens: 32_768 } },
  { prefix: 'gemini', limits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 } },
  { prefix: 'deepseek', limits: { contextWindow: 64_000, maxOutputTokens: 8_000 } },
  { prefix: 'llama', limits: { contextWindow: 128_000, maxOutputTokens: 4_096 } },
  { prefix: 'qwen', limits: { contextWindow: 32_000, maxOutputTokens: 8_000 } },
  { prefix: 'mistral', limits: { contextWindow: 32_000, maxOutputTokens: 8_000 } },
  { prefix: 'glm', limits: { contextWindow: 128_000, maxOutputTokens: 8_000 } },
].sort((a, b) => b.prefix.length - a.prefix.length)

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
