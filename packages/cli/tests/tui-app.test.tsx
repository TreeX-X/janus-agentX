/**
 * Ink App smoke: real render frames + typed input over a stub transport.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { App } from '../src/tui/App.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

async function waitForFrame(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for frame: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function openSession(): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-app-')),
    model: 'm',
    apiKey: 'k',
    store: memoryConversationStore(),
    streamTextFn: (async () => ({
      textStream: (async function* () { yield 'stub-answer' })(),
    })) as ChatTurnPorts['streamTextFn'],
    env: {} as NodeJS.ProcessEnv,
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

async function typeLine(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  // NOTE: text and Enter must be separate writes; a bundled '\r' is taken literally.
  stdin.write(text)
  await new Promise((resolve) => setTimeout(resolve, 50))
  stdin.write('\r')
}

describe('App', () => {
  it('renders the empty state, answers a turn, and exits on /exit', async () => {
    const session = await openSession()
    let exitCode: number | null = null
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={(code) => { exitCode = code }}
      />,
    )
    try {
      expect(lastFrame()).toContain('██')
      expect(lastFrame()).toContain('Type a message to start')
      expect(lastFrame()).toContain('janus')
      await typeLine(stdin, 'hello turn')
      await waitForFrame(() => (lastFrame() ?? '').includes('hello turn'))
      await waitForFrame(() => (lastFrame() ?? '').includes('stub-answer'))
      await typeLine(stdin, '/exit')
      await waitForFrame(() => exitCode !== null)
      expect(exitCode).toBe(0)
    } finally {
      unmount()
      await session.close()
    }
  })

  it('runs slash commands inline', async () => {
    const session = await openSession()
    let exitCode: number | null = null
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={(code) => { exitCode = code }}
      />,
    )
    try {
      await typeLine(stdin, '/new research')
      await waitForFrame(() => (lastFrame() ?? '').includes('new conversation:'))
      await typeLine(stdin, '/list')
      await waitForFrame(() => (lastFrame() ?? '').includes('research'))
      expect(exitCode).toBeNull()
    } finally {
      unmount()
      await session.close()
    }
  })
})
