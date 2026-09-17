/**
 * Output token budgets for workspace tools.
 *
 * Every read/search/list/overview output reports `estimatedTokens` so the
 * model can plan follow-up calls; an explicit `maxTokens` further truncates
 * the variable-length portion (lines, matches, entries) with the original
 * counts and a narrowing hint. The estimator mirrors
 * `estimateContextTokens` in chat-core (ASCII ≈ 4 chars/token, non-ASCII ≈
 * 1 char/token, conservative); agent-core keeps a local copy because it must
 * not depend on chat-core.
 */

// Note: bounded outputs carry token counts and narrowing guidance — see .agents/notes/implemented/bug-fix/2026-09-16-read-paging-token-amplification.md
/** Default budget only documents the output scale; tools enforce their own page caps unless the caller passes maxTokens. */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 10_000
export const MAX_OUTPUT_TOKEN_BUDGET = 100_000

export function estimateOutputTokens(value: string): number {
  const nonAscii = value.match(/[^\x00-\x7f]/gu)?.length ?? 0
  return Math.ceil((value.length - nonAscii) / 4 + nonAscii)
}

export function parseOutputTokenBudget(value: unknown, toolName: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKEN_BUDGET) {
    throw new Error(`${toolName} maxTokens must be an integer between 1 and ${MAX_OUTPUT_TOKEN_BUDGET}`)
  }
  return value
}

/** Drop trailing items until the joined text fits the budget; keeps at least one item. */
export function fitItemsToBudget<T>(items: T[], toText: (item: T) => string, maxTokens: number): { items: T[]; truncated: boolean } {
  let end = items.length
  while (end > 1 && estimateOutputTokens(items.slice(0, end).map(toText).join('\n')) > maxTokens) {
    end -= 1
  }
  return { items: items.slice(0, end), truncated: end < items.length }
}

// Note: opencode-style global text cap for model-facing values — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
// Structured runtime outputs stay complete in details/traces/UI; only the
// text the model re-reads every turn is capped here. Matches opencode
// Truncate (2000 lines / 50KB): overflows name a narrower re-query instead
// of inviting a full re-read, so truncated bodies never silently re-enter
// context turn after turn.
/** Max model-facing text lines per tool result (opencode Truncate parity). */
export const MODEL_TEXT_MAX_LINES = 2000
/** Max model-facing text bytes per tool result (opencode Truncate parity). */
export const MODEL_TEXT_MAX_BYTES = 50 * 1024

/** Cap model-facing text head-first; the hint must name the narrower re-query. */
export function truncateModelText(text: string, hint: string): string {
  const lines = text.split('\n')
  let kept = lines
  let truncated = false
  if (kept.length > MODEL_TEXT_MAX_LINES) {
    kept = kept.slice(0, MODEL_TEXT_MAX_LINES)
    truncated = true
  }
  let out = kept.join('\n')
  while (out.length > 0 && Buffer.byteLength(out, 'utf-8') > MODEL_TEXT_MAX_BYTES) {
    const cut = Math.max(1, Math.floor(kept.length * 0.9))
    if (cut >= kept.length) break
    kept = kept.slice(0, cut)
    out = kept.join('\n')
    truncated = true
  }
  if (!truncated) return text
  return `${out}\n\n(Output truncated to ${MODEL_TEXT_MAX_LINES} lines/${MODEL_TEXT_MAX_BYTES / 1024}KB. ${hint})`
}
