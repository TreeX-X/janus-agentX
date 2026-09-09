/**
 * @file Provider setup wizard for the janus CLI (opencode `/connect` equivalent).
 * @description Pure driver over an injected `ConnectIO`: both TUI hosts (plain
 * readline + Ink) share the exact flow — pick or add a provider, store its key
 * in auth.json (never echoed, never logged), test `GET /models`, optionally
 * pick a model. Network is injectable so tests stay offline.
 */
import { isProviderEnabled, type ProviderEntry } from './providers.js'
import { DEFAULT_BASE_URL } from './session.js'

export interface ConnectAsk {
  /** Resolve the answer; null = aborted (Ctrl+C/EOF) and cancels the wizard. */
  (prompt: string, opts?: { secret?: boolean }): Promise<string | null>
}

export interface ConnectIO {
  ask: ConnectAsk
  print: (line: string) => void
  warn: (line: string) => void
}

/** Structural subset of CliSession used by the wizard (satisfied by CliSession). */
export interface ConnectSession {
  listProviders(): { entries: ProviderEntry[]; activeId: string }
  findProvider(ref: string): ProviderEntry | null
  keySourceFor(providerId: string): string | null
  getModelId(): string | undefined
  getApiKey(): string | undefined
  getApiKeySource(): string | null
  getAuthPath(): string | null
  setProvider(ref: string): void
  setModel(modelId: string): void
  upsertProvider(entry: ProviderEntry): void
  saveProviderKey(providerId: string, key: string): void
  removeProvider(ref: string): { id: string; removedKey: boolean }
}

export interface ConnectionTest {
  ok: boolean
  models: string[]
  error?: string
}

export type TestConnectionFn = (
  baseURL: string,
  apiKey: string,
  timeoutMs?: number,
) => Promise<ConnectionTest>

export function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * Best-effort reachability probe. Any failure is a *warning*, never fatal:
 * exotic providers may lack `/models` while serving chat fine.
 */
export async function testConnection(
  baseURL: string,
  apiKey: string,
  timeoutMs = 15000,
): Promise<ConnectionTest> {
  const url = `${normalizeBaseUrl(baseURL)}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` }
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null
    const data = body?.data
    const models = Array.isArray(data)
      ? data
        .map((item) => (item as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string' && !!id)
      : []
    return { ok: true, models }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, models: [], error: 'timed out' }
    }
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** One-line provider roster with key status for `/connect` (no args). */
export function formatConnectList(
  session: Pick<ConnectSession, 'listProviders' | 'keySourceFor'>,
): string[] {
  const { entries, activeId } = session.listProviders()
  if (entries.length === 0) return ['providers: (none — the wizard will add your first: /connect <id>)']
  const lines = ['providers (key status — setup with /connect <id>):']
  for (const entry of entries) {
    const source = session.keySourceFor(entry.id)
    const name = entry.name ? ` (${entry.name})` : ''
    const key = source ? `key ✓ (${source})` : 'key ✗ (missing)'
    lines.push(`${entry.id === activeId ? '*' : ' '} ${entry.id}${name} — ${key}`)
  }
  return lines
}

export interface ConnectWizardOptions {
  /** Skip provider selection (exact id or unique prefix; unknown = new provider). */
  ref?: string
  /** Skip the key prompt (quick form `/connect <id> <key>`). */
  key?: string
  /** Override baseURL (new providers, or update an existing entry). */
  baseURL?: string
  testConnection?: TestConnectionFn
  timeoutMs?: number
}

export interface ConnectResult {
  providerId: string | null
  tested: boolean
}

function isNewIdShape(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ref.trim())
}

export async function runConnectWizard(
  session: ConnectSession,
  io: ConnectIO,
  opts: ConnectWizardOptions = {},
): Promise<ConnectResult> {
  const testFn = opts.testConnection ?? testConnection
  let entry: ProviderEntry | null = null
  let isNew = false

  if (opts.ref) {
    entry = session.findProvider(opts.ref)
    if (!entry) {
      if (!isNewIdShape(opts.ref)) {
        io.warn(`janus: unknown provider "${opts.ref}". Use /connect to pick from the list.`)
        return { providerId: null, tested: false }
      }
      entry = { id: opts.ref.trim() }
      isNew = true
    }
  } else {
    const { entries } = session.listProviders()
    const enabled = entries.filter(isProviderEnabled)
    if (enabled.length === 0) {
      const answer = await io.ask('new provider id (enter=cancel): ')
      if (answer === null || !answer.trim()) {
        io.print('connect cancelled.')
        return { providerId: null, tested: false }
      }
      if (!isNewIdShape(answer)) {
        io.warn('janus: provider id must match [A-Za-z0-9_-].')
        return { providerId: null, tested: false }
      }
      entry = { id: answer.trim() }
      isNew = true
    } else {
      io.print('providers:')
      enabled.forEach((candidate, index) => {
        const source = session.keySourceFor(candidate.id)
        io.print(`  ${index + 1}. ${candidate.id}${candidate.name ? ` (${candidate.name})` : ''}${source ? ` [key ✓]` : ' [key ✗]'}`)
      })
      const answer = await io.ask('provider number or id (enter=cancel, new id to add): ')
      if (answer === null || !answer.trim()) {
        io.print('connect cancelled.')
        return { providerId: null, tested: false }
      }
      const trimmed = answer.trim()
      const byNumber = /^\d+$/.test(trimmed) ? enabled[Number(trimmed) - 1] : undefined
      entry = byNumber ?? session.findProvider(trimmed)
      if (!entry) {
        if (!isNewIdShape(trimmed)) {
          io.warn(`janus: unknown provider "${trimmed}".`)
          return { providerId: null, tested: false }
        }
        entry = { id: trimmed }
        isNew = true
      }
    }
  }

  const baseURL = opts.baseURL?.trim() || entry.baseURL
  if (isNew || opts.baseURL?.trim()) {
    if (isNew && !opts.baseURL?.trim()) {
      const answer = await io.ask(`baseURL for "${entry.id}" (enter=${DEFAULT_BASE_URL}): `)
      if (answer === null) {
        io.print('connect cancelled.')
        return { providerId: null, tested: false }
      }
      entry = { ...entry, baseURL: answer.trim() ? normalizeBaseUrl(answer) : DEFAULT_BASE_URL }
    } else {
      entry = { ...entry, baseURL: opts.baseURL?.trim() ? normalizeBaseUrl(opts.baseURL) : entry.baseURL }
    }
    session.upsertProvider(entry)
    io.print(`provider saved: ${entry.id}${entry.baseURL ? ` (${entry.baseURL})` : ''}`)
  }

  const previousSource = session.keySourceFor(entry.id)
  let key = opts.key?.trim() || ''
  if (!key) {
    const answer = await io.ask(
      `API key for "${entry.id}"${previousSource ? ` (enter=keep via ${previousSource})` : ''}: `,
      { secret: true },
    )
    if (answer === null) {
      io.print('connect cancelled.')
      return { providerId: null, tested: false }
    }
    key = answer.trim()
  }
  if (key) {
    session.saveProviderKey(entry.id, key)
    io.print(session.getAuthPath()
      ? `key saved to auth.json for "${entry.id}" (never shown again).`
      : `key kept for this run only (no auth file — restart loses it).`)
  } else if (!previousSource) {
    io.warn(`janus: no key for "${entry.id}" — set one later with /connect ${entry.id}.`)
  }

  try {
    session.setProvider(entry.id)
  } catch (error) {
    io.warn(error instanceof Error ? error.message : String(error))
    return { providerId: null, tested: false }
  }

  // Probe reachability; failures warn but never roll back the saved setup.
  let tested = false
  const probeKey = key || session.getApiKey()
  if (probeKey) {
    const probeUrl = entry.baseURL ?? DEFAULT_BASE_URL
    io.print(`testing ${normalizeBaseUrl(probeUrl)}/models …`)
    const result = await testFn(probeUrl, probeKey, opts.timeoutMs)
    tested = result.ok
    if (result.ok) {
      io.print(`reachable · ${result.models.length} model(s) listed.`)
      if (result.models.length > 0 && (!entry.models || entry.models.length === 0)) {
        const preview = result.models.slice(0, 8).join(', ')
        const current = session.getModelId() ?? '(none)'
        const answer = await io.ask(`model to use [${preview}] (enter=keep ${current}): `)
        if (answer === null) {
          io.print('connect cancelled.')
          return { providerId: entry.id, tested }
        }
        if (answer.trim()) {
          try {
            session.setModel(answer.trim())
          } catch (error) {
            io.warn(error instanceof Error ? error.message : String(error))
          }
        }
      }
    } else {
      io.warn(`connection test failed: ${result.error ?? 'unknown error'} (setup saved; check baseURL/key).`)
    }
  }

  const source = session.getApiKeySource()
  io.print(`connected: ${entry.id} · model ${session.getModelId() ?? '(none — pick with /model)'} · key ${source ? `via ${source}` : 'missing'}`)
  return { providerId: entry.id, tested }
}
