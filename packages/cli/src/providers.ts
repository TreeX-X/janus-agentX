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
  modelId?: string
  models?: string[]
  defaultModelId?: string
  enabled?: boolean
}

export interface ProviderCatalog {
  version: 1
  providers: ProviderEntry[]
  defaultProvider?: string
  defaultModel?: string
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
  return {
    id: record.id.trim(),
    name: optionalString(record.name),
    baseURL: optionalString(record.baseURL),
    modelId: optionalString(record.modelId),
    models: strings(record.models),
    defaultModelId: optionalString(record.defaultModelId),
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
  return catalog
}

export function serializeCatalog(catalog: ProviderCatalog): string {
  return JSON.stringify(catalog)
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
