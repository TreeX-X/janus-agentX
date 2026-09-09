/**
 * Shared command executor: identical output for plain + Ink hosts.
 * Real CliSession over memory store, stub transport.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeCommand } from '../src/tui/exec.js'
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
    expect((await executeCommand(session, 'model', ['m2'])).stdout).toEqual(['model switched: m2'])
    expect((await executeCommand(session, 'model', ['nope'])).stderr.join('')).toContain('unknown model')
    expect((await executeCommand(session, 'provider', [])).stdout.join('')).toContain('* a')
    expect((await executeCommand(session, 'provider', ['b'])).stdout.join('')).toContain('provider switched: b')
    expect((await executeCommand(session, 'provider', ['nope'])).stderr.join('')).toContain('unknown provider')
    await session.close()
  })

  it('shows and switches approval modes', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'approval', [])).stdout).toEqual(['approval: auto-run'])
    expect((await executeCommand(session, 'approval', ['per-action'])).stdout.join('')).toContain('per-action')
    expect((await executeCommand(session, 'approval', ['sometimes'])).stderr).toEqual(['usage: /approval [auto-run|per-action]'])
    await session.close()
  })

  it('shows api-key status and sets it without echoing', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'key', [])).stdout).toEqual([
      'api key: set (flags > env > /key, memory only)',
    ])
    const set = await executeCommand(session, 'key', ['sk-rotated'])
    expect(set.stdout).toEqual(['api key set for this run (memory only, never written to disk).'])
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

  it('rejects unknown commands', async () => {
    const session = await openSession()
    expect((await executeCommand(session, 'frobnicate', [])).stderr).toEqual(['unknown command: /frobnicate (type /help)'])
    await session.close()
  })
})
