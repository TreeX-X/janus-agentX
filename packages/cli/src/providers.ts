/**
 * @file Provider catalog for the janus CLI (framework-agnostic, no IO by default).
 * @description Field names mirror JanusX `llm-core/core/types.ts ProviderSettings`
 * so a future JanusX adapter can share shapes. Secrets never touch disk:
 * `apiKey` is stripped on parse and only ever comes from flags/env.
 * Precedence: flags/env model+baseURL > file defaults > provider chain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProviderEntry {
  id: string
  name?: string
  baseURL?: string
  /** Env var holding this provider's key (e.g. "DEEPSEEK_API_KEY"). Secrets never touch disk. */
  apiKeyEnv?: string
  modelId?: string
  models?: string[]
  defaultModelId?: string
  /** Context-window override for every model on this provider (wins over the built-in table). */
  contextWindow?: number
  /** Max-output override for every model on this provider. */
  maxOutputTokens?: number
  /** CodeX parity: per-provider default reasoning effort (e.g. "medium"). */
  effort?: string
  enabled?: boolean
}

export interface ProviderCatalog {
  version: 1
  providers: ProviderEntry[]
  defaultProvider?: string
  defaultModel?: string
  /** CodeX parity: global default reasoning effort (flag/env win over this). */
  defaultEffort?: string
}

export function emptyCatalog(): ProviderCatalog {
  return { version: 1, providers: [] }
}

function sanitizeEntry(value: unknown): ProviderEntry | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record.id !== 'string' || !record.id.trim()) return null
  const strings = (input: unknown): string[] | undefined => {
    if (!Array.isArray(input)) return undefined
    const items = input.filter((item): item is string => typeof item === 'string' && !!item.trim())
    return items.length > 0 ? [...new Set(items)] : undefined
  }
  const optionalString = (input: unknown): string | undefined =>
    typeof input === 'string' && input.trim() ? input : undefined
  const optionalEnvName = (input: unknown): string | undefined => {
    const name = optionalString(input)
    return name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined
  }
  const optionalEffort = (input: unknown): string | undefined => {
    const name = optionalString(input)?.toLowerCase()
    return name && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(name)
      ? name
      : undefined
  }
  const optionalPositiveInt = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isSafeInteger(input) && input > 0 ? input : undefined
  return {
    id: record.id.trim(),
    name: optionalString(record.name),
    baseURL: optionalString(record.baseURL),
    apiKeyEnv: optionalEnvName(record.apiKeyEnv),
    modelId: optionalString(record.modelId),
    models: strings(record.models),
    defaultModelId: optionalString(record.defaultModelId),
    contextWindow: optionalPositiveInt(record.contextWindow),
    maxOutputTokens: optionalPositiveInt(record.maxOutputTokens),
    effort: optionalEffort(record.effort),
    // NOTE: apiKey is deliberately never read from disk.
    enabled: record.enabled === false ? false : undefined,
  }
}

/** Parses untrusted JSON; drops secrets and malformed entries. */
export function parseCatalog(value: unknown): ProviderCatalog {
  const record = value as Record<string, unknown> | null
  const providers = Array.isArray(record?.providers)
    ? (record.providers as unknown[]).map(sanitizeEntry).filter((entry): entry is ProviderEntry => !!entry)
    : []
  const catalog: ProviderCatalog = { version: 1, providers }
  if (record && typeof record.defaultProvider === 'string' && record.defaultProvider) {
    catalog.defaultProvider = record.defaultProvider
  }
  if (record && typeof record.defaultModel === 'string' && record.defaultModel) {
    catalog.defaultModel = record.defaultModel
  }
  if (record && typeof record.defaultEffort === 'string') {
    const effort = record.defaultEffort.trim().toLowerCase()
    if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
      catalog.defaultEffort = effort
    }
  }
  return catalog
}

export function serializeCatalog(catalog: ProviderCatalog): string {
  return JSON.stringify(catalog, null, 2)
}

export function defaultConfigPath(): string {
  return join(homedir(), '.janus', 'config.json')
}

export function loadCatalogFile(
  path: string,
  onError?: (error: unknown, operation: 'load' | 'save') => void,
): ProviderCatalog {
  try {
    if (!existsSync(path)) return emptyCatalog()
    return parseCatalog(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    onError?.(error, 'load')
    return emptyCatalog()
  }
}

export function saveCatalogFile(
  path: string,
  catalog: ProviderCatalog,
  onError?: (error: unknown, operation: 'load' | 'save') => void,
): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${serializeCatalog(catalog)}\n`, 'utf8')
  } catch (error) {
    onError?.(error, 'save')
  }
}

/** Single-provider catalog synthesized from flags (headless/tests stay file-free). */
export function synthesizeCatalog(input: { model?: string; baseUrl?: string }): ProviderCatalog {
  const provider: ProviderEntry = { id: 'openai-compatible', name: 'OpenAI Compatible' }
  if (input.model) provider.modelId = input.model
  if (input.baseUrl) provider.baseURL = input.baseUrl
  return { version: 1, providers: [provider] }
}

export interface CatalogInput {
  /** Resolved config path, or null to skip the file entirely. Undefined = default path. */
  configPath?: string | null
  model?: string
  baseUrl?: string
  onError?: (error: unknown, operation: 'load' | 'save') => void
}

/** File providers win over synthesis; an empty file falls back to flags. */
export function loadEffectiveCatalog(input: CatalogInput = {}): { catalog: ProviderCatalog; configPath: string | null } {
  const configPath = input.configPath === null ? null : (input.configPath ?? defaultConfigPath())
  const file = configPath ? loadCatalogFile(configPath, input.onError) : emptyCatalog()
  if (file.providers.length > 0) return { catalog: file, configPath }
  return { catalog: synthesizeCatalog({ model: input.model, baseUrl: input.baseUrl }), configPath }
}

export function isProviderEnabled(entry: ProviderEntry): boolean {
  return entry.enabled !== false
}

/** Explicit id > file default > single enabled > first enabled. */
export function resolveActiveProvider(catalog: ProviderCatalog, providerId?: string): ProviderEntry | null {
  const enabled = catalog.providers.filter(isProviderEnabled)
  if (providerId) return enabled.find((entry) => entry.id === providerId) ?? null
  if (catalog.defaultProvider) {
    const named = enabled.find((entry) => entry.id === catalog.defaultProvider)
    if (named) return named
  }
  if (enabled.length === 1) return enabled[0]
  return enabled[0] ?? null
}

/** Unique-prefix match for terminal ergonomics; null when ambiguous. */
export function resolveProviderRef(catalog: ProviderCatalog, ref: string): ProviderEntry | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const enabled = catalog.providers.filter(isProviderEnabled)
  const exact = enabled.find((entry) => entry.id === trimmed)
  if (exact) return exact
  const prefixed = enabled.filter((entry) => entry.id.startsWith(trimmed))
  return prefixed.length === 1 ? prefixed[0] : null
}

export function listProviderModels(entry: ProviderEntry): string[] {
  const models = [...(entry.models ?? [])]
  for (const candidate of [entry.modelId, entry.defaultModelId]) {
    if (candidate && !models.includes(candidate)) models.push(candidate)
  }
  return models
}

/** Explicit override > provider default chain. */
export function effectiveModelId(entry: ProviderEntry, override?: string): string | undefined {
  if (override) return override
  return entry.modelId ?? entry.models?.[0] ?? entry.defaultModelId
}

/**
 * Closed-world providers (non-empty `models`) reject unknown ids so typos
 * never reach billing; open providers (synthesized single endpoints) allow any.
 */
export function validateModelId(entry: ProviderEntry, modelId: string): boolean {
  if (!entry.models || entry.models.length === 0) return true
  return listProviderModels(entry).includes(modelId)
}

export interface ResolvedApiKey {
  key: string | undefined
  /** Env var name the key came from (`apiKeyEnv` or JANUS_API_KEY); undefined when absent. */
  source: string | undefined
}

/**
 * Per-provider key lookup (env only, never disk):
 * `<apiKeyEnv>` > `JANUS_API_KEY`. Flag (`--api-key`) and session overrides
 * live in the session and win over this.
 */
export function resolveApiKey(
  env: NodeJS.ProcessEnv,
  entry: ProviderEntry,
): ResolvedApiKey {
  const varName = entry.apiKeyEnv
  if (varName) {
    const value = env[varName]
    if (value) return { key: value, source: varName }
  }
  if (env.JANUS_API_KEY) return { key: env.JANUS_API_KEY, source: 'JANUS_API_KEY' }
  return { key: undefined, source: undefined }
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const next = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = next
    }
  }
  return prev[b.length]
}

/** Typo-tolerant suggestions for unknown provider/model ids (up to `limit`). */
export function suggestSimilar(candidates: string[], input: string, limit = 2): string[] {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return []
  const scored: Array<{ candidate: string; score: number }> = []
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    if (lower.includes(trimmed) || trimmed.includes(lower)) {
      scored.push({ candidate, score: 0 })
      continue
    }
    const distance = editDistance(lower, trimmed)
    // Short inputs only match by substring (edit distance is noise there).
    const threshold = trimmed.length <= 2 ? 0 : Math.min(2, Math.floor(trimmed.length / 3))
    if (distance <= threshold && distance > 0) scored.push({ candidate, score: distance })
  }
  scored.sort((x, y) => x.score - y.score)
  return scored.slice(0, limit).map((row) => row.candidate)
}

/** ` Did you mean "a" (or "b")?` or '' when there is nothing close. */
export function formatDidYouMean(suggestions: string[]): string {
  if (suggestions.length === 0) return ''
  const quoted = suggestions.map((s) => `"${s}"`).join(' or ')
  return ` Did you mean ${quoted}?`
}
