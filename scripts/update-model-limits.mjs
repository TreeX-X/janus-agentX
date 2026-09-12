#!/usr/bin/env node
/**
 * Refresh assistant for the CLI model window table.
 * @description Compares `packages/cli/src/model-limits.table.ts` against a
 * documented catalog (models.dev api.json by default) and reports drift.
 * No runtime fetch by design: this runs on dev machines and CI only.
 *
 * Usage:
 *   node scripts/update-model-limits.mjs [--api <url|path>] [--table <path>]
 *   node scripts/update-model-limits.mjs --check        # CI: exit 1 on unsafe rows
 *   node scripts/update-model-limits.mjs --apply-safe   # auto-lower unsafe floors only
 *
 * Report classes: UNSAFE (table above documented: overflow risk),
 * LOW (table below documented: early compact, human review), UNCOVERED
 * (no prefix matches: candidate for a new row, human review).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySafeLower, diffTable } from './model-limits-diff.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_API = 'https://models.dev/api.json'
const DEFAULT_TABLE = 'packages/cli/src/model-limits.table.ts'
const ROW_RE = /\{\s*prefix:\s*'([^']+)'\s*,\s*contextWindow:\s*(\d+)\s*,\s*maxOutputTokens:\s*(\d+)\s*\}/g
const MAX_PRINT = 30

function arg(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readTableRows(path) {
  const text = readFileSync(path, 'utf8')
  const rows = []
  for (const match of text.matchAll(ROW_RE)) {
    rows.push({ prefix: match[1], contextWindow: Number(match[2]), maxOutputTokens: Number(match[3]) })
  }
  if (rows.length === 0) throw new Error(`no table rows parsed from ${path}`)
  return rows
}

function normalizeApi(api) {
  const rows = []
  const providers = api && typeof api === 'object' ? api : {}
  for (const [provider, entry] of Object.entries(providers)) {
    const models = entry && typeof entry === 'object' && entry.models && typeof entry.models === 'object'
      ? entry.models
      : {}
    for (const [id, model] of Object.entries(models)) {
      const limit = model && typeof model === 'object' ? model.limit ?? {} : {}
      const context = limit.context ?? limit.input
      if (!Number.isSafeInteger(context) || context <= 0) continue
      rows.push({ id: `${provider}/${id}`, model: id, context })
    }
  }
  return rows
}

async function loadApi(source) {
  if (!/^https?:\/\//.test(source)) return readJson(resolve(ROOT, source))
  const response = await fetch(source, { headers: { 'user-agent': 'janus-agentx-table-refresh' } })
  if (!response.ok) throw new Error(`models.dev fetch failed: HTTP ${response.status}`)
  return response.json()
}

function printGroup(title, items, format) {
  console.log(`${title} (${items.length})`)
  for (const item of items.slice(0, MAX_PRINT)) console.log(`  ${format(item)}`)
  if (items.length > MAX_PRINT) console.log(`  … and ${items.length - MAX_PRINT} more`)
}

function readJson(path) {
  // Snapshots saved on Windows often carry a BOM; strip it before parsing.
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
}

async function main() {
  const tablePath = resolve(ROOT, arg('--table') ?? DEFAULT_TABLE)
  const rows = readTableRows(tablePath)
  const api = await loadApi(arg('--api') ?? DEFAULT_API)
  const diff = diffTable(rows, normalizeApi(api))

  printGroup('UNSAFE — table would overflow', diff.unsafe,
    (hit) => `${hit.id} documented ${hit.documented} < prefix '${hit.prefix}' ${hit.resolved}`)
  printGroup('LOW — table compacts early, review', diff.low,
    (hit) => `${hit.id} documented ${hit.documented} > prefix '${hit.prefix}' ${hit.resolved}`)
  printGroup('UNCOVERED — no prefix matches', diff.uncovered,
    (hit) => `${hit.id} documented ${hit.documented}`)

  if (process.argv.includes('--apply-safe')) {
    const { changes } = applySafeLower(rows, diff)
    if (changes.length === 0) {
      console.log('apply-safe: nothing unsafe, table unchanged.')
    } else {
      let text = readFileSync(tablePath, 'utf8')
      for (const change of changes) {
        const before = `prefix: '${change.prefix}', contextWindow: ${change.from}`
        const after = `prefix: '${change.prefix}', contextWindow: ${change.to}`
        if (!text.includes(before)) throw new Error(`row changed shape, refusing to edit: ${change.prefix}`)
        text = text.replace(before, after)
        console.log(`apply-safe: '${change.prefix}' ${change.from} -> ${change.to}`)
      }
      writeFileSync(tablePath, text)
    }
  }

  if (process.argv.includes('--check') && diff.unsafe.length > 0) {
    console.error(`check failed: ${diff.unsafe.length} unsafe row(s)`)
    process.exitCode = 1
  }
}

await main()
