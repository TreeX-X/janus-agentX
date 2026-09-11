/**
 * Shared command executor: identical output for plain + Ink hosts.
 * Real CliSession over memory store, stub transport.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeCommand } from '../src/tui/exec.js'
import { formatEffortList } from '../src/effort.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import { parseCatalog } from '../src/providers.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn
}

async function openSession(): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-exec-')),
    model: 'm',
    apiKey: 'k',
    store: memoryConversationStore(),
    catalog: parseCatalog({ providers: [{ id: 'a', models: ['m', 'm2'] }, { id: 'b', models: ['n'] }] }),
    streamTextFn: textStub(),
    env: {} as NodeJS.ProcessEnv,
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

describe('executeCommand', () => {
  it('runs help/exit/clear', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'help', [])).stdout.join('')).toContain('/exit')
    expect((await executeCommand(session, 'exit', [])).exit).toBe(true)
    expect((await executeCommand(session, 'clear', [])).stdout).toEqual(['history cleared.'])
    await session.close()
  })

  it('manages conversations end to end', async () => {
    const session = await openSession()
    const created = await executeCommand(session, 'new', ['research'])
    expect(created.stdout.join('')).toContain('new conversation:')
    const listed = await executeCommand(session, 'list', [])
    expect(listed.stdout.join('')).toContain('research')
    const switched = await executeCommand(session, 'switch', ['2'])
    expect(switched.stdout.join('')).toContain('switched to:')
    expect((await executeCommand(session, 'switch', [])).stderr).toEqual(['usage: /switch <number|id>'])
    expect((await executeCommand(session, 'switch', ['nope'])).stderr).toEqual(['no conversation matches: nope'])
    const renamed = await executeCommand(session, 'rename', ['main'])
    expect(renamed.stdout).toEqual(['renamed to: main'])
    expect((await executeCommand(session, 'rename', [])).stderr).toEqual(['usage: /rename <title>'])
    const deleted = await executeCommand(session, 'delete', ['1'])
    expect(deleted.stdout.join('')).toContain('deleted. active:')
    await session.close()
  })

  it('switches model/provider with listings and errors', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'model', [])).stdout.join('')).toContain('* m')
    expect((await executeCommand(session, 'model', ['m2'])).stdout).toEqual(['model switched: m2 · effort: medium'])
    expect((await executeCommand(session, 'model', ['nope'])).stderr.join('')).toContain('unknown model')
    expect((await executeCommand(session, 'provider', [])).stdout.join('')).toContain('* a')
    expect((await executeCommand(session, 'provider', ['b'])).stdout.join('')).toContain('provider switched: b')
    expect((await executeCommand(session, 'provider', ['nope'])).stderr.join('')).toContain('unknown provider')
    await session.close()
  })

  it('shows and switches approval modes', async () => {
    const session = await openSession()
    const shown = (await executeCommand(session, 'approval', [])).stdout.join('\n')
    expect(shown).toContain('approval: auto-run')
    expect(shown).toContain('per-action')
    expect((await executeCommand(session, 'approval', ['per-action'])).stdout.join('')).toContain('per-action')
    expect((await executeCommand(session, 'approval', ['sometimes'])).stderr).toEqual(['usage: /approval [auto-run|per-action]'])
    await session.close()
  })

  it('shows api-key status and sets it without echoing', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'key', [])).stdout).toEqual([
      'api key: set (/key > --api-key > <apiKeyEnv> > JANUS_API_KEY, memory only)',
    ])
    const set = await executeCommand(session, 'key', ['sk-rotated'])
    expect(set.stdout).toEqual(['api key set for this run (memory only, never written to disk). Use /connect to persist per-provider keys.'])
    expect(set.stdout.join('')).not.toContain('sk-rotated')
    expect(session.getApiKey()).toBe('sk-rotated')
    await session.close()
  })

  it('reports workspace state and delegates recreation', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'workspace', [])).stdout.join('')).toContain('workspace:')
    expect((await executeCommand(session, 'workspace', ['/x'])).stderr).toEqual(['janus: workspace switching is unavailable here.'])
    const recreated = await executeCommand(session, 'workspace', ['/x'], {
      recreateWorkspace: async (dir) => ({ ok: true, message: `moved to ${dir}` }),
    })
    expect(recreated.stdout).toEqual(['moved to /x'])
    expect(recreated.workspaceSwitched).toBe(true)
    const failed = await executeCommand(session, 'workspace', ['/x'], {
      recreateWorkspace: async () => ({ ok: false, message: 'janus: nope' }),
    })
    expect(failed.stderr).toEqual(['janus: nope'])
    expect(failed.workspaceSwitched).toBeUndefined()
    await session.close()
  })

  it('lists connect key status and defers wizard runs to the host', async () => {
    const session = await openSession()
    const list = await executeCommand(session, 'connect', [])
    expect(list.stdout.join('\n')).toContain('key ✗ (missing)')
    expect(list.stdout.join('')).not.toContain('sk-')
    const wizard = await executeCommand(session, 'connect', ['a', 'sk-x'])
    expect(wizard.connect).toEqual({ ref: 'a', key: 'sk-x', baseURL: undefined })
    expect(wizard.stdout).toEqual([])
    await session.close()
  })

  it('removes providers via /provider rm with guards', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'provider', ['rm'])).stderr.join('')).toContain('unknown provider')
    expect((await executeCommand(session, 'provider', ['rm', 'a'])).stderr.join('')).toContain('active provider')
    const removed = await executeCommand(session, 'provider', ['rm', 'b'])
    expect(removed.stdout).toEqual(['provider removed: b'])
    expect((await executeCommand(session, 'provider', [])).stdout.join('')).not.toContain(' b')
    await session.close()
  })

  it('rejects unknown commands', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'frobnicate', [])).stderr).toEqual(['unknown command: /frobnicate (type /help)'])
    await session.close()
  })

  it('shows the effective provider/model/baseURL/key/config in /status', async () => {
    const session = await openSession()
    const out = (await executeCommand(session, 'status', [])).stdout.join('\n')
    expect(out).toContain('provider: a')
    expect(out).toContain('model: m')
    expect(out).toContain('effort: medium')
    expect(out).toContain('baseURL: https://api.openai.com/v1')
    expect(out).toContain('api key: set (via --api-key)')
    expect(out).toContain('config: (memory only, no file)')
    expect(out).not.toContain('sk-')
    expect(out).not.toContain(' k\n')
    await session.close()
  })

  it('shows and switches reasoning effort via /effort', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'effort', [])).stdout).toEqual([formatEffortList('medium')])
    expect((await executeCommand(session, 'effort', ['high'])).stdout).toEqual([
      'effort switched: high — deep reasoning (hard tasks · slower)',
    ])
    expect(session.getEffort()).toBe('high')
    expect((await executeCommand(session, 'effort', ['nope'])).stderr.join('')).toContain('unknown effort')
    expect((await executeCommand(session, 'effort', ['1'])).stdout.join('')).toContain('effort switched: none')
    expect(session.getEffort()).toBe('none')
    expect((await executeCommand(session, 'status', [])).stdout.join('\n')).toContain('effort: none')
    await session.close()
  })

  it('hints close matches for unknown provider/model ids', async () => {
    const session = await openSession()
    // Single-char catalog (a/b, m/m2/n): short inputs get no fuzzy hint.
    expect((await executeCommand(session, 'provider', ['c'])).stderr.join('')).not.toContain('Did you mean')
    await session.close()
  })
})
