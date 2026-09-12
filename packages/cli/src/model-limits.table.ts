/**
 * GENERATED DATA — do not hand-edit values here without a source.
 * @description Built-in model window rows, newest-first by curation date.
 * Each row is one line matching `ROW_RE` in `scripts/update-model-limits.mjs`;
 * keep that shape so the refresh script can read this file. Sources:
 * provider docs and router catalogs (see per-row note). Values stay
 * conservative (small) on doubt: guessing low only compacts early,
 * guessing high overflows the provider. `maxOutputTokens` never drives
 * today's budget (capped at 2048 in `ChatSessionRuntime`) and is kept
 * plausible, not exact.
 *
 * Refresh: `npm run update:model-limits` (report) or with `--apply-safe`
 * (auto-lowers unsafe floors only). CI runs `--check` weekly.
 *
 * Note: why a checked-in table instead of adaptive learning or live
 * discovery — see .agents/notes/implemented/feature/2026-09-12-model-window-table.md
 */

export interface ModelLimitRow {
  /** Lowercase id prefix; longest match wins (`kimi-k3` beats `kimi-k2`). */
  prefix: string
  contextWindow: number
  maxOutputTokens: number
  /** Provenance tag lives in the trailing comment: openai-docs | provider-docs | router-catalog | weights-card. */
  note?: string
}

export const MODEL_LIMIT_ROWS: ModelLimitRow[] = [
  { prefix: 'gpt-5.6', contextWindow: 1050000, maxOutputTokens: 128000 }, // openai-docs
  { prefix: 'gpt-4.1', contextWindow: 1000000, maxOutputTokens: 32768 }, // openai-docs
  { prefix: 'gpt-4.5', contextWindow: 128000, maxOutputTokens: 16384 }, // openai-docs
  { prefix: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 }, // openai-docs
  { prefix: 'gpt-oss', contextWindow: 128000, maxOutputTokens: 8000 }, // openai-docs
  { prefix: 'gpt-5', contextWindow: 400000, maxOutputTokens: 128000 }, // openai-docs
  { prefix: 'o1-mini', contextWindow: 128000, maxOutputTokens: 32000 }, // openai-docs
  { prefix: 'o1', contextWindow: 200000, maxOutputTokens: 100000 }, // openai-docs
  { prefix: 'o3', contextWindow: 200000, maxOutputTokens: 100000 }, // openai-docs
  { prefix: 'o4', contextWindow: 200000, maxOutputTokens: 100000 }, // router-catalog
  { prefix: 'claude', contextWindow: 200000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'gemini', contextWindow: 1000000, maxOutputTokens: 64000 }, // provider-docs
  { prefix: 'deepseek-v4', contextWindow: 1000000, maxOutputTokens: 32000 }, // router-catalog
  { prefix: 'deepseek-v3.2', contextWindow: 128000, maxOutputTokens: 8000 }, // router-catalog
  { prefix: 'deepseek', contextWindow: 64000, maxOutputTokens: 8000 }, // provider-docs
  { prefix: 'kimi-k2-0711', contextWindow: 128000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'kimi-k2', contextWindow: 256000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'kimi-k3', contextWindow: 1050000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'moonshot-v1-8k', contextWindow: 8000, maxOutputTokens: 4000 }, // router-catalog
  { prefix: 'moonshot-v1-32k', contextWindow: 32000, maxOutputTokens: 16000 }, // router-catalog
  { prefix: 'moonshot-v1-128k', contextWindow: 128000, maxOutputTokens: 16000 }, // router-catalog
  { prefix: 'moonshot', contextWindow: 8000, maxOutputTokens: 4000 }, // provider-docs
  { prefix: 'llama', contextWindow: 128000, maxOutputTokens: 4096 }, // weights-card
  { prefix: 'mistral-large', contextWindow: 128000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'mistral', contextWindow: 32000, maxOutputTokens: 8000 }, // provider-docs
  { prefix: 'codestral', contextWindow: 128000, maxOutputTokens: 4000 }, // provider-docs
  { prefix: 'qwen3-coder', contextWindow: 256000, maxOutputTokens: 32000 }, // weights-card
  { prefix: 'qwen3.6-plus', contextWindow: 1000000, maxOutputTokens: 32000 }, // router-catalog
  { prefix: 'qwen3.6-flash', contextWindow: 1000000, maxOutputTokens: 32000 }, // router-catalog
  { prefix: 'qwen3.6-max', contextWindow: 256000, maxOutputTokens: 32000 }, // router-catalog
  { prefix: 'qwen', contextWindow: 32000, maxOutputTokens: 8000 }, // weights-card
  { prefix: 'glm-4-long', contextWindow: 1000000, maxOutputTokens: 4000 }, // router-catalog
  { prefix: 'glm-4.7', contextWindow: 200000, maxOutputTokens: 128000 }, // router-catalog
  { prefix: 'glm-5', contextWindow: 200000, maxOutputTokens: 128000 }, // router-catalog
  { prefix: 'glm', contextWindow: 128000, maxOutputTokens: 8000 }, // provider-docs
  { prefix: 'doubao-seed-1-6', contextWindow: 256000, maxOutputTokens: 16000 }, // router-catalog
  { prefix: 'doubao-seed-1-8', contextWindow: 256000, maxOutputTokens: 16000 }, // router-catalog
  { prefix: 'doubao', contextWindow: 128000, maxOutputTokens: 16000 }, // provider-docs
  { prefix: 'minimax', contextWindow: 200000, maxOutputTokens: 32000 }, // provider-docs
  { prefix: 'grok', contextWindow: 128000, maxOutputTokens: 8000 }, // provider-docs
]
