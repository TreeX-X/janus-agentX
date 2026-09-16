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
