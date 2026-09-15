/**
 * Pure comparison core for the model window refresh script.
 * @description No IO: compares curated prefix rows against documented
 * provider values (e.g. models.dev api.json). Imported by both
 * `update-model-limits.mjs` and the vitest suite, so the safety rules
 * below are pinned by tests, not just by the script's report text.
 *
 * Note: why authoritative-only, text-only, tolerance — see .agents/notes/implemented/bug-fix/2026-09-15-model-limits-check.md
 */

/**
 * Providers that own the weights/docs for the families in the table.
 * Router/gateway catalogs (openrouter, greenpt, nano-gpt, tokengo, …)
 * routinely republish truncated windows; comparing the table against
 * their minimum makes weekly CI permanently red. Rows that carry an
 * explicit `provider` outside this set are skipped, never unsafe.
 */
export const AUTHORITATIVE_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'google-vertex',
  'deepseek',
  'moonshotai',
  'moonshotai-cn',
  'mistral',
  'alibaba',
  'alibaba-cn',
  'zai',
  'zhipuai',
  'volcengine',
  'minimax',
  'minimax-cn',
  'xai',
  'meta',
  'stepfun',
])

/** Rounding noise (1000000 vs 1048576 vs 1050000) is not overflow. */
export const UNSAFE_TOLERANCE = 0.05

function providerOf(row) {
  if (row && typeof row.provider === 'string' && row.provider.length > 0) return row.provider
  if (row && typeof row.id === 'string') {
    const slash = row.id.indexOf('/')
    if (slash > 0) return row.id.slice(0, slash)
  }
  return undefined
}

function isComparable(row) {
  const provider = providerOf(row)
  if (provider !== undefined && !AUTHORITATIVE_PROVIDERS.has(provider)) return false
  if (Array.isArray(row?.output)) {
    if (!(row.output.length === 1 && row.output[0] === 'text')) return false
  }
  const model = String(row?.model ?? row?.id ?? '').toLowerCase()
  if (model.includes('embed')) return false
  return true
}

export function resolvePrefix(prefixes, modelId) {
  const id = String(modelId ?? '').trim().toLowerCase()
  let best = null
  for (const row of prefixes) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) best = row
  }
  return best
}

/**
 * apiRows: [{ id, model, provider?, output?, context }] with positive documented windows.
 * Returns unsafe (table above documented: overflow risk), low (table below
 * documented: early compact, human review), uncovered (no prefix matches),
 * plus skipped (non-authoritative or non-chat rows, never a signal).
 */
export function diffTable(prefixes, apiRows) {
  const unsafe = []
  const low = []
  const uncovered = []
  let skipped = 0
  for (const row of apiRows) {
    if (!row || !Number.isSafeInteger(row.context) || row.context <= 0) continue
    if (!isComparable(row)) {
      skipped += 1
      continue
    }
    const match = resolvePrefix(prefixes, row.model ?? row.id)
    if (!match) {
      uncovered.push({ id: row.id, documented: row.context })
      continue
    }
    if (match.contextWindow > row.context) {
      if ((match.contextWindow - row.context) / match.contextWindow <= UNSAFE_TOLERANCE) continue
      unsafe.push({ id: row.id, documented: row.context, resolved: match.contextWindow, prefix: match.prefix })
    } else if (match.contextWindow < row.context) {
      low.push({ id: row.id, documented: row.context, resolved: match.contextWindow, prefix: match.prefix })
    }
  }
  return { unsafe, low, uncovered, skipped }
}

/**
 * Provably safe auto-fix: only lowers prefix floors to the documented
 * minimum of the rows they match. Never raises, never adds prefixes —
 * those change blast radius and stay human-reviewed.
 */
export function applySafeLower(prefixes, diff) {
  const floorByPrefix = new Map()
  for (const hit of diff.unsafe) {
    const current = floorByPrefix.get(hit.prefix)
    floorByPrefix.set(hit.prefix, current === undefined ? hit.documented : Math.min(current, hit.documented))
  }
  const changes = []
  const rows = prefixes.map((row) => {
    if (!floorByPrefix.has(row.prefix) || floorByPrefix.get(row.prefix) >= row.contextWindow) return row
    const to = floorByPrefix.get(row.prefix)
    changes.push({ prefix: row.prefix, from: row.contextWindow, to })
    return { ...row, contextWindow: to }
  })
  return { rows, changes }
}
