/**
 * auth.json key store + /connect wizard driver (opencode-style provider setup).
 * Stubbed IO and local HTTP servers only: no real network, no home-dir writes.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emptyAuth,
  loadAuthFile,
  parseAuth,
  saveAuthFile,
} from '../src/auth.js'
import {
  formatConnectList,
  runConnectWizard,
  testConnection,
  type ConnectIO,
  type ConnectSession,
} from '../src/connect.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import { arrayLineSource, runRepl } from '../src/repl.js'
import { saveCatalogFile } from '../src/providers.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { ProviderEntry } from '../src/providers.js'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn
}

/** In-memory ConnectSession double (mirrors the CliSession surface the driver uses). */
function fakeSession(entries: ProviderEntry[] = [{ id: 'ds', baseURL: 'http://ds/v1' }]): ConnectSession & {
  savedKeys: Record<string, string>
  providers: ProviderEntry[]
  activeId: string
  model?: string
} {
  const savedKeys: Record<string, string> = {}
  const providers = entries.map((entry) => ({ ...entry }))
  const session: ConnectSession & {
    savedKeys: Record<string, string>
    providers: ProviderEntry[]
    activeId: string
    model?: string
  } = {
    savedKeys,
    providers,
    activeId: providers[0]?.id ?? '',
    model: undefined,
    listProviders: () => ({ entries: providers, activeId: session.activeId }),
    findProvider: (ref: string) => {
      const trimmed = ref.trim()
      const exact = providers.find((entry) => entry.id === trimmed)
      if (exact) return exact
      const prefixed = providers.filter((entry) => entry.id.startsWith(trimmed))
      return prefixed.length === 1 ? prefixed[0] : null
    },
    keySourceFor: (id: string) => (savedKeys[id] ? 'auth.json' : null),
    getModelId: () => session.model,
    getApiKey: () => savedKeys[session.activeId],
    getApiKeySource: () => (savedKeys[session.activeId] ? 'auth.json' : null),
    getAuthPath: () => '/tmp/auth.json',
    setProvider: (ref: string) => { session.activeId = ref },
    setModel: (modelId: string) => { session.model = modelId },
    upsertProvider: (entry: ProviderEntry) => {
      const index = providers.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) providers[index] = entry
      else providers.push(entry)
    },
    saveProviderKey: (id: string, key: string) => { savedKeys[id] = key },
    removeProvider: () => { throw new Error('not implemented in fake') },
  }
  return session
}

/** Scripted ask(): answers in order, records prompts (incl. secret flags). */
function scriptedIO(answers: Array<string | null>): ConnectIO & { out: string[]; err: string[]; prompts: Array<{ prompt: string; secret: boolean }> } {
  const out: string[] = []
  const err: string[] = []
  const prompts: Array<{ prompt: string; secret: boolean }> = []
  let index = 0
  return {
    out,
    err,
    prompts,
    print: (line: string) => { out.push(line) },
    warn: (line: string) => { err.push(line) },
    ask: async (prompt: string, opts?: { secret?: boolean }) => {
      prompts.push({ prompt, secret: opts?.secret ?? false })
      if (index >= answers.length) throw new Error(`out of scripted answers at: ${prompt}`)
      return answers[index++] as string | null
    },
  }
}

describe('auth file', () => {
  it('round-trips keys and drops garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-auth-'))
    const path = join(dir, 'auth.json')
    expect(loadAuthFile(path).keys).toEqual({})
    saveAuthFile(path, { version: 1, keys: { ds: 'sk-live' } })
    expect(loadAuthFile(path).keys).toEqual({ ds: 'sk-live' })
    expect(readFileSync(path, 'utf8')).toContain('\n  "keys"')
    expect(parseAuth({ keys: { a: 'k', b: 42, '': 'x', c: '' } }).keys).toEqual({ a: 'k' })
    expect(parseAuth(null)).toEqual(emptyAuth())
    expect(parseAuth('nope')).toEqual(emptyAuth())
  })
})

describe('CliSession auth keys', () => {
  async function openSession(extra: Record<string, unknown> = {}): Promise<CliSession> {
    const session = await CliSession.create({
      workspace: mkdtempSync(join(tmpdir(), 'janus-auth-session-')),
      catalog: {
        version: 1,
        providers: [
          { id: 'ds', baseURL: 'http://ds/v1', modelId: 'm-ds', apiKeyEnv: 'DEEPSEEK_API_KEY' },
          { id: 'oa', baseURL: 'http://oa/v1', modelId: 'm-oa' },
        ],
      },
      store: memoryConversationStore(),
      streamTextFn: textStub(),
      env: { DEEPSEEK_API_KEY: 'k-env' } as NodeJS.ProcessEnv,
      ...extra,
    } as Parameters<typeof CliSession.create>[0])
    if (isSessionValidationError(session)) throw new Error(session.message)
    return session
  }

  it('prefers auth.json over env and reports sources per provider', async () => {
    const session = await openSession({ authKeys: { oa: 'k-auth' } })
    expect(session.getApiKeySource()).toBe('DEEPSEEK_API_KEY')
    expect(session.keySourceFor('ds')).toBe('DEEPSEEK_API_KEY')
    session.setProvider('oa')
    expect(session.getApiKey()).toBe('k-auth')
    expect(session.getApiKeySource()).toBe('auth.json')
    expect(session.keySourceFor('oa')).toBe('auth.json')
    expect(session.keySourceFor('nope')).toBeNull()
    await session.close()
  })

  it('lets session and --api-key win over auth.json', async () => {
    const session = await openSession({ authKeys: { ds: 'k-auth' } })
    expect(session.getApiKeySource()).toBe('auth.json')
    session.setApiKey('k-run')
    expect(session.getApiKeySource()).toBe('session')
    await session.close()

    const flagged = await openSession({ authKeys: { ds: 'k-auth' }, apiKey: 'k-flag' })
    expect(flagged.getApiKey()).toBe('k-flag')
    expect(flagged.getApiKeySource()).toBe('--api-key')
    await flagged.close()
  })

  it('persists wizard keys to the auth file and catalog entries to config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-auth-persist-'))
    const authPath = join(dir, 'auth.json')
    const configPath = join(dir, 'config.json')
    const session = await openSession({ authPath, configPath })
    session.upsertProvider({ id: 'nw', baseURL: 'http://nw/v1', modelId: 'm-nw' })
    session.saveProviderKey('nw', 'sk-new')
    expect(loadAuthFile(authPath).keys).toEqual({ nw: 'sk-new' })
    expect(JSON.parse(readFileSync(configPath, 'utf8')).providers.map((p: { id: string }) => p.id)).toContain('nw')
    // Switching to the new provider picks up its saved key.
    session.setProvider('nw')
    expect(session.getApiKey()).toBe('sk-new')
    expect(session.getApiKeySource()).toBe('auth.json')
    expect(() => session.saveProviderKey('nw', '   ')).toThrow(/usage/)
    await session.close()
  })

  it('removes providers with key cleanup while guarding the active one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-auth-remove-'))
    const authPath = join(dir, 'auth.json')
    const configPath = join(dir, 'config.json')
    const session = await openSession({ authKeys: { oa: 'k-oa' }, authPath, configPath })
    expect(() => session.removeProvider('oaa')).toThrow(/Did you mean "oa"/)
    // oa is not active (ds is): removal drops the entry and its key.
    const removed = session.removeProvider('oa')
    expect(removed).toEqual({ id: 'oa', removedKey: true })
    expect(session.listProviders().entries.map((entry) => entry.id)).toEqual(['ds'])
    expect(loadAuthFile(authPath).keys).toEqual({})
    expect(() => session.removeProvider('ds')).toThrow(/active provider/)
    await session.close()
  })
})

describe('formatConnectList', () => {
  it('shows key status per provider without leaking key material', () => {
    const session = fakeSession([
      { id: 'ds', name: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      { id: 'oa' },
    ])
    session.savedKeys.ds = 'sk-live'
    const text = formatConnectList(session).join('\n')
    expect(text).toContain('* ds (DeepSeek) — key ✓ (auth.json)')
    expect(text).toContain('oa — key ✗ (missing)')
    expect(text).not.toContain('sk-live')
  })
})

describe('runConnectWizard', () => {
  it('walks an existing provider: key (secret) -> test -> model pick', async () => {
    const session = fakeSession()
    const io = scriptedIO(['sk-wizard', 'm-picked'])
    const result = await runConnectWizard(session, io, {
      ref: 'ds',
      testConnection: async () => ({ ok: true, models: ['m-a', 'm-b'] }),
    })
    expect(result).toEqual({ providerId: 'ds', tested: true })
    expect(session.savedKeys).toEqual({ ds: 'sk-wizard' })
    expect(session.model).toBe('m-picked')
    expect(io.prompts[0]?.secret).toBe(true)
    const all = [...io.out, ...io.err].join('\n')
    expect(all).toContain('key saved to auth.json')
    expect(all).toContain('reachable · 2 model(s)')
    expect(all).toContain('connected: ds · model m-picked')
    expect(all).not.toContain('sk-wizard')
  })

  it('adds a brand-new provider with baseURL and warns (not fails) on probe errors', async () => {
    const session = fakeSession([])
    session.activeId = ''
    const io = scriptedIO(['http://nw/v1/', 'sk-new', ''])
    const result = await runConnectWizard(session, io, {
      ref: 'nw',
      testConnection: async () => ({ ok: false, models: [], error: 'HTTP 401' }),
    })
    expect(result).toEqual({ providerId: 'nw', tested: false })
    expect(session.providers).toMatchObject([{ id: 'nw', baseURL: 'http://nw/v1' }])
    expect(io.err.join('\n')).toContain('connection test failed: HTTP 401')
    expect(io.out.join('\n')).toContain('provider saved: nw (http://nw/v1)')
  })

  it('supports the quick form and keeps the current model on empty pick', async () => {
    const session = fakeSession()
    session.model = 'm-keep'
    const io = scriptedIO([''])
    const result = await runConnectWizard(session, io, {
      ref: 'ds',
      key: 'sk-quick',
      testConnection: async () => ({ ok: true, models: ['m-a'] }),
    })
    expect(result.providerId).toBe('ds')
    expect(session.savedKeys.ds).toBe('sk-quick')
    expect(session.model).toBe('m-keep')
    expect(io.prompts).toHaveLength(1) // model pick only; key came from args
  })

  it('cancels cleanly on empty selection or abort', async () => {
    const session = fakeSession()
    expect(await runConnectWizard(session, scriptedIO(['']), {})).toEqual({ providerId: null, tested: false })
    expect(await runConnectWizard(session, scriptedIO([null]), { ref: 'ds' })).toEqual({ providerId: null, tested: false })
    expect(session.savedKeys).toEqual({})
  })

  it('rejects malformed new provider ids', async () => {
    const session = fakeSession()
    const io = scriptedIO([])
    expect(await runConnectWizard(session, io, { ref: 'not an id!' })).toEqual({ providerId: null, tested: false })
    expect(io.err.join('\n')).toContain('unknown provider')
  })
})

describe('testConnection', () => {
  async function withServer(handler: (req: { url?: string }) => { status: number; body: unknown }): Promise<{ server: Server; base: string }> {
    const server = createServer((req, res) => {
      const { status, body } = handler(req)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    return { server, base }
  }

  it('lists models on 200 and reports HTTP failures', async () => {
    const { server, base } = await withServer(() => ({ status: 200, body: { data: [{ id: 'm-1' }, { id: 'm-2' }] } }))
    try {
      const ok = await testConnection(base, 'k')
      expect(ok).toEqual({ ok: true, models: ['m-1', 'm-2'] })
    } finally {
      server.close()
    }
    const denied = await withServer(() => ({ status: 401, body: { error: 'nope' } }))
    try {
      expect(await testConnection(denied.base, 'bad')).toMatchObject({ ok: false, error: 'HTTP 401' })
    } finally {
      denied.server.close()
    }
  })

  it('fails fast on unreachable hosts', async () => {
    const probe = createServer(() => undefined)
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const result = await testConnection(`http://127.0.0.1:${port}/v1`, 'k', 5000)
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toBeTruthy()
  })
})

describe('runRepl /connect', () => {
  it('lists key status and runs the wizard end to end without leaking the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-connect-'))
    const configPath = join(mkdtempSync(join(tmpdir(), 'janus-repl-connectcfg-')), 'config.json')
    const authPath = join(mkdtempSync(join(tmpdir(), 'janus-repl-connectauth-')), 'auth.json')
    saveCatalogFile(configPath, {
      version: 1,
      providers: [{ id: 'ds', name: 'DeepSeek', baseURL: 'http://ds/v1' }],
    })
    const out: string[] = []
    const err: string[] = []
    const code = await runRepl(
      { workspace: dir, plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: (text) => { err.push(text) },
        env: {} as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath,
        authPath,
        lines: arrayLineSource(['/connect', '/connect ds', 'sk-wizard-e2e', '', '/status', '/exit']),
        testConnection: async () => ({ ok: true, models: ['m-x'] }),
        streamTextFn: textStub(),
      },
    )
    expect(code).toBe(0)
    const all = out.join('') + err.join('')
    expect(all).toContain('key ✗ (missing)')
    expect(all).toContain('key saved to auth.json')
    expect(all).toContain('connected: ds')
    expect(all).toContain('key via auth.json')
    expect(loadAuthFile(authPath).keys).toEqual({ ds: 'sk-wizard-e2e' })
    expect(all).not.toContain('sk-wizard-e2e')
  })
})
