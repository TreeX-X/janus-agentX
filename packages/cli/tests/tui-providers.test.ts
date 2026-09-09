/**
 * Provider catalog: parse/sanitize, precedence, resolution, session switching.
 * Stub transport, no network, tmp config files only.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  effectiveModelId,
  emptyCatalog,
  formatDidYouMean,
  listProviderModels,
  loadCatalogFile,
  loadEffectiveCatalog,
  parseCatalog,
  resolveActiveProvider,
  resolveApiKey,
  resolveProviderRef,
  saveCatalogFile,
  serializeCatalog,
  suggestSimilar,
  synthesizeCatalog,
  validateModelId,
  type ProviderCatalog,
} from '../src/providers.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import { arrayLineSource, runRepl } from '../src/repl.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn
}

function closedCatalog(): ProviderCatalog {
  return {
    version: 1,
    providers: [
      { id: 'a', name: 'A', baseURL: 'http://a/v1', modelId: 'm-a1', models: ['m-a1', 'm-a2'] },
      { id: 'b', name: 'B', models: ['m-b1', 'm-b2'], defaultModelId: 'm-b1', enabled: true },
      { id: 'off', models: ['m-off'], enabled: false },
    ],
    defaultProvider: 'a',
    defaultModel: 'm-a2',
  }
}

describe('parseCatalog', () => {
  it('drops secrets and malformed entries', () => {
    const catalog = parseCatalog({
      providers: [
        { id: 'a', apiKey: 'sk-should-never-load', models: ['m', 'm', 42] },
        { id: '', models: ['x'] },
        null,
        { id: 'b', enabled: false },
      ],
      defaultProvider: 'a',
    })
    expect(catalog.providers).toHaveLength(2)
    expect(JSON.stringify(catalog)).not.toContain('sk-should-never-load')
    expect(catalog.providers[0]).toMatchObject({ id: 'a', models: ['m'] })
    expect(catalog.providers[0]).not.toHaveProperty('apiKey')
    expect(catalog.providers[1]).toMatchObject({ id: 'b', enabled: false })
  })

  it('handles garbage input as empty', () => {
    expect(parseCatalog(null)).toEqual(emptyCatalog())
    expect(parseCatalog({ providers: 'nope' }).providers).toEqual([])
  })
})

describe('resolution', () => {
  it('prefers explicit > default > single > first and skips disabled', () => {
    const catalog = closedCatalog()
    expect(resolveActiveProvider(catalog, 'b')?.id).toBe('b')
    expect(resolveActiveProvider(catalog)?.id).toBe('a')
    expect(resolveActiveProvider(catalog, 'off')).toBeNull()
    expect(resolveActiveProvider(catalog, 'missing')).toBeNull()
    const single = parseCatalog({ providers: [{ id: 'solo' }] })
    expect(resolveActiveProvider(single)?.id).toBe('solo')
    expect(resolveActiveProvider(emptyCatalog())).toBeNull()
  })

  it('matches provider refs exactly or by unique prefix', () => {
    const catalog = closedCatalog()
    expect(resolveProviderRef(catalog, 'b')?.id).toBe('b')
    expect(resolveProviderRef(catalog, '')).toBeNull()
    expect(resolveProviderRef(catalog, 'o')).toBeNull() // disabled 'off' is invisible; nothing else matches
    const close = parseCatalog({ providers: [{ id: 'ab-1' }, { id: 'ab-2' }] })
    expect(resolveProviderRef(close, 'ab')).toBeNull()
    expect(resolveProviderRef(close, 'ab-2')?.id).toBe('ab-2')
  })

  it('lists models deduped and validates closed vs open worlds', () => {
    expect(listProviderModels(closedCatalog().providers[0])).toEqual(['m-a1', 'm-a2'])
    expect(validateModelId(closedCatalog().providers[0], 'm-a2')).toBe(true)
    expect(validateModelId(closedCatalog().providers[0], 'nope')).toBe(false)
    expect(validateModelId(synthesizeCatalog({}).providers[0], 'anything')).toBe(true)
    expect(effectiveModelId(closedCatalog().providers[1])).toBe('m-b1')
    expect(effectiveModelId(closedCatalog().providers[1], 'override')).toBe('override')
  })

  it('loads files with fallback to flags and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-catalog-'))
    const path = join(dir, 'config.json')
    saveCatalogFile(path, closedCatalog())
    expect(loadCatalogFile(path).defaultProvider).toBe('a')
    expect(loadCatalogFile(join(dir, 'missing.json')).providers).toEqual([])

    const fromFile = loadEffectiveCatalog({ configPath: path, model: 'ignored-override' })
    expect(fromFile.catalog.providers).toHaveLength(3)
    expect(fromFile.configPath).toBe(path)
    const fromFlags = loadEffectiveCatalog({ configPath: null, model: 'm', baseUrl: 'http://x/v1' })
    expect(fromFlags.catalog.providers[0]).toMatchObject({ id: 'openai-compatible', modelId: 'm', baseURL: 'http://x/v1' })
    expect(fromFlags.configPath).toBeNull()
    expect(readFileSync(path, 'utf8')).toContain('m-a1')
  })

  it('keeps apiKeyEnv names and drops malformed ones', () => {
    const catalog = parseCatalog({
      providers: [
        { id: 'a', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        { id: 'b', apiKeyEnv: 'not a var!' },
      ],
    })
    expect(catalog.providers[0]).toMatchObject({ id: 'a', apiKeyEnv: 'DEEPSEEK_API_KEY' })
    expect(catalog.providers[1].apiKeyEnv).toBeUndefined()
  })

  it('resolves keys per provider: <apiKeyEnv> wins over JANUS_API_KEY', () => {
    const entry = { id: 'a', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    expect(resolveApiKey({ DEEPSEEK_API_KEY: 'k1', JANUS_API_KEY: 'k2' } as NodeJS.ProcessEnv, entry))
      .toEqual({ key: 'k1', source: 'DEEPSEEK_API_KEY' })
    expect(resolveApiKey({ JANUS_API_KEY: 'k2' } as NodeJS.ProcessEnv, entry))
      .toEqual({ key: 'k2', source: 'JANUS_API_KEY' })
    expect(resolveApiKey({} as NodeJS.ProcessEnv, entry))
      .toEqual({ key: undefined, source: undefined })
  })

  it('serializes catalogs pretty-printed for hand editing', () => {
    expect(serializeCatalog(closedCatalog())).toContain('\n  "providers"')
  })

  it('suggests close matches and formats the hint', () => {
    expect(suggestSimilar(['deepseek', 'openai'], 'depseek')).toEqual(['deepseek'])
    expect(suggestSimilar(['m-b1', 'm-b2'], 'm-b3')).toEqual(['m-b1', 'm-b2'])
    expect(suggestSimilar(['a', 'b'], 'c')).toEqual([])
    expect(formatDidYouMean(['deepseek'])).toBe(' Did you mean "deepseek"?')
    expect(formatDidYouMean([])).toBe('')
  })
})

describe('CliSession providers', () => {
  it('applies flags > env > file > provider chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-prov-precedence-'))
    const table = [
      { extra: { model: 'm-a1' }, env: { JANUS_MODEL: 'env-model' }, expected: 'm-a1' },
      { extra: {}, env: { JANUS_MODEL: 'env-model' }, expected: 'env-model' },
      { extra: {}, env: {}, expected: 'm-a2' },
    ] as const
    for (const row of table) {
      const session = await CliSession.create({
        workspace: dir,
        apiKey: 'k',
        catalog: closedCatalog(),
        store: memoryConversationStore(),
        streamTextFn: textStub(),
        ...row.extra,
        env: { ...row.env } as NodeJS.ProcessEnv,
      })
      if (isSessionValidationError(session)) throw new Error(session.message)
      expect(session.getModelId()).toBe(row.expected)
      expect(session.getProviderId()).toBe('a')
      await session.close()
    }
  })

  it('rejects unknown models and providers with actionable errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-prov-errors-'))
    const badModel = await CliSession.create({
      workspace: dir, model: 'nope', apiKey: 'k', catalog: closedCatalog(), store: memoryConversationStore(), streamTextFn: textStub(),
    })
    expect(isSessionValidationError(badModel) && badModel.code).toBe('unknown-model')
    const badProvider = await CliSession.create({
      workspace: dir, apiKey: 'k', catalog: closedCatalog(), providerId: 'nope', store: memoryConversationStore(), streamTextFn: textStub(),
    })
    expect(isSessionValidationError(badProvider) && badProvider.code).toBe('unknown-provider')
  })

  it('switches provider/model and persists defaults to the config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-prov-switch-'))
    const configPath = join(mkdtempSync(join(tmpdir(), 'janus-prov-cfg-')), 'config.json')
    saveCatalogFile(configPath, closedCatalog())
    const session = await CliSession.create({
      workspace: dir,
      apiKey: 'k',
      catalog: loadCatalogFile(configPath),
      configPath,
      store: memoryConversationStore(),
      streamTextFn: textStub(),
      env: {} as NodeJS.ProcessEnv,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    expect(session.getModelId()).toBe('m-a2')

    session.setProvider('b')
    expect(session.getProviderId()).toBe('b')
    expect(session.getModelId()).toBe('m-b1')
    session.setModel('m-b1')
    expect(() => session.setModel('nope')).toThrow(/unknown model/)
    expect(() => session.setProvider('off')).toThrow(/unknown provider/)
    await session.close()

    const reloaded = loadCatalogFile(configPath)
    expect(reloaded.defaultProvider).toBe('b')
    expect(reloaded.defaultModel).toBe('m-b1')

    const second = await CliSession.create({
      workspace: dir,
      apiKey: 'k',
      catalog: loadCatalogFile(configPath),
      configPath,
      store: memoryConversationStore(),
      streamTextFn: textStub(),
      env: {} as NodeJS.ProcessEnv,
    })
    if (isSessionValidationError(second)) throw new Error(second.message)
    expect(second.getProviderId()).toBe('b')
    expect(second.getModelId()).toBe('m-b1')
    await second.close()
  })
})

describe('runRepl providers', () => {
  it('lists and switches provider/model, persisting defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-prov-'))
    const configPath = join(mkdtempSync(join(tmpdir(), 'janus-repl-provcfg-')), 'config.json')
    saveCatalogFile(configPath, closedCatalog())
    const out: string[] = []
    const err: string[] = []
    const code = await runRepl(
      { workspace: dir, plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: (text) => { err.push(text) },
        env: { JANUS_API_KEY: 'k' } as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath,
        authPath: null,
        lines: arrayLineSource(['/provider', '/model', '/provider b', '/model', '/model m-b2', '/exit']),
        streamTextFn: textStub(),
      },
    )
    expect(code).toBe(0)
    const all = out.join('')
    expect(all).toContain('* a (A)')
    expect(all).toContain('* m-a2')
    expect(all).toContain('provider switched: b · model m-b1')
    expect(all).toContain('* m-b1')
    expect(all).toContain('model switched: m-b2')
    expect(err.join('')).toBe('')
    const saved = loadCatalogFile(configPath)
    expect(saved.defaultProvider).toBe('b')
    expect(saved.defaultModel).toBe('m-b2')
  })

  it('reports unknown provider/model without exiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-proverr-'))
    const out: string[] = []
    const err: string[] = []
    const code = await runRepl(
      { workspace: dir, plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: (text) => { err.push(text) },
        env: { JANUS_API_KEY: 'k', JANUS_MODEL: 'm' } as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        authPath: null,
        lines: arrayLineSource(['/provider nope', '/model nope', '/exit']),
        streamTextFn: textStub(),
      },
    )
    expect(code).toBe(0)
    // Synthesized open-world endpoint allows any model id.
    expect(out.join('')).toContain('model switched: nope')
    expect(err.join('')).toContain('unknown provider "nope"')
  })
})
