/**
 * Manual /compact: forced summarization, persistence round-trip, and
 * failure reporting. Real CliSession over a shared memory store with a
 * stub transport (no network).
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

const VALID_SUMMARY = [
  '## Goal', 'Ship it',
  '## Constraints & Preferences', '(none)',
  '## Progress', '### Done', '- [x] a', '### In Progress', '- [ ] b', '### Blocked', '(none)',
  '## Key Decisions', '(none)',
  '## Next Steps', '1. go',
  '## Critical Context', '(none)',
  '## Relevant Files', '(none)',
].join('\n')

type StreamFn = ChatTurnPorts['streamTextFn']

function stub(text: string): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield text })(),
  })) as StreamFn
}

async function openSession(input: {
  model?: string
  apiKey?: string
  streamText?: string
  store?: ReturnType<typeof memoryConversationStore>
  catalog?: Parameters<typeof parseCatalog>[0]
}): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-compact-')),
    model: input.model,
    apiKey: input.apiKey,
    store: input.store ?? memoryConversationStore(),
    catalog: parseCatalog(input.catalog ?? { providers: [{ id: 'a', models: ['m', 'gpt-4o'] }] }),
    streamTextFn: stub(input.streamText ?? VALID_SUMMARY),
    env: {} as NodeJS.ProcessEnv,
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

describe('/compact', () => {
  it('compacts a long history, persists it, and rehydrates on reload', async () => {
    const store = memoryConversationStore()
    const session = await openSession({ model: 'm', apiKey: 'k', store })
    await session.sendTurn(`first exploration ${'x'.repeat(1200)}`)
    const out = await executeCommand(session, 'compact', [])
    expect(out.stderr).toEqual([])
    expect(out.stdout.join('')).toContain('Compacted context into a')
    await session.close()

    const resumed = await openSession({ model: 'm', apiKey: 'k', store })
    const again = await executeCommand(resumed, 'compact', [])
    expect(again.stdout.join('')).toContain('Already compacted')
    await resumed.close()
  })

  it('reports short histories without burning a model call', async () => {
    let calls = 0
    const session = await CliSession.create({
      workspace: mkdtempSync(join(tmpdir(), 'janus-compact-short-')),
      model: 'm',
      apiKey: 'k',
      store: memoryConversationStore(),
      catalog: parseCatalog({ providers: [{ id: 'a', models: ['m'] }] }),
      streamTextFn: (async () => {
        calls += 1
        return { textStream: (async function* () { yield VALID_SUMMARY })() }
      }) as StreamFn,
      env: {} as NodeJS.ProcessEnv,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    const out = await executeCommand(session, 'compact', [])
    expect(out.stdout.join('')).toContain('Nothing to compact')
    expect(calls).toBe(0)
    await session.close()
  })

  it('refuses without a model and surfaces invalid summaries', async () => {
    const nomodel = await openSession({ apiKey: 'k', catalog: { providers: [{ id: 'a' }] } })
    expect((await executeCommand(nomodel, 'compact', [])).stderr.join('')).toContain('needs a model')
    await nomodel.close()

    const junk = await openSession({ model: 'm', apiKey: 'k', streamText: 'junk without headings' })
    await junk.sendTurn(`first exploration ${'x'.repeat(1200)}`)
    const out = await executeCommand(junk, 'compact', [])
    expect(out.stderr.join('')).toContain('invalid summary')
    await junk.close()
  })
})
