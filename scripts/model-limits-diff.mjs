/**
 * Pure comparison core for the model window refresh script.
 * @description No IO: compares curated prefix rows against documented
 * provider values (e.g. models.dev api.json). Imported by both
 * `update-model-limits.mjs` and the vitest suite, so the safety rules
 * below are pinned by tests, not just by the script's report text.
 */

export function resolvePrefix(prefixes, modelId) {
  const id = String(modelId ?? '').trim().toLowerCase()
  let best = null
  for (const row of prefixes) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) best = row
  }
  return best
}

/**
 * apiRows: [{ id, context, output }] with positive documented windows.
 * Returns unsafe (table above documented: overflow risk), low (table below
 * documented: early compact, human review), uncovered (no prefix matches).
 */
export function diffTable(prefixes, apiRows) {
  const unsafe = []
  const low = []
  const uncovered = []
  for (const row of apiRows) {
    if (!row || !Number.isSafeInteger(row.context) || row.context <= 0) continue
    const match = resolvePrefix(prefixes, row.model ?? row.id)
    if (!match) {
      uncovered.push({ id: row.id, documented: row.context })
      continue
    }
    if (match.contextWindow > row.context) {
      unsafe.push({ id: row.id, documented: row.context, resolved: match.contextWindow, prefix: match.prefix })
    } else if (match.contextWindow < row.context) {
      low.push({ id: row.id, documented: row.context, resolved: match.contextWindow, prefix: match.prefix })
    }
  }
  return { unsafe, low, uncovered }
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
