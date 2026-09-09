/**
 * Ink App smoke: real render frames + typed input over a stub transport.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
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

async function typeText(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  stdin.write(text)
  await new Promise((resolve) => setTimeout(resolve, 50))
}

async function press(stdin: { write: (data: string) => void }, key: string): Promise<void> {
  stdin.write(key)
  await new Promise((resolve) => setTimeout(resolve, 50))
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
      expect(lastFrame()).toContain('message (/help)')
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

  it('inserts a newline on Shift+Enter (LF) and submits both lines on Enter', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      await typeText(stdin, 'line1')
      await press(stdin, '\n')
      await typeText(stdin, 'line2')
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('stub-answer'))
      const frame = lastFrame() ?? ''
      expect(frame).toContain('line1')
      expect(frame).toContain('line2')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('applies slash completion on Tab', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      await typeText(stdin, '/mo')
      await waitForFrame(() => (lastFrame() ?? '').includes('/model'))
      await press(stdin, '\t')
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('model:'))
    } finally {
      unmount()
      await session.close()
    }
  })

  it('shows a tool card row when the turn calls tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-app-tools-'))
    writeFileSync(join(dir, 'hello.txt'), 'tool-content-here')
    let calls = 0
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      store: memoryConversationStore(),
      streamTextFn: (async () => {
        calls += 1
        if (calls === 1) {
          return {
            fullStream: (async function* () {
              yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'cli', path: 'hello.txt' } }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () {})(),
          }
        }
        return { textStream: (async function* () { yield 'saw it' })() }
      }) as ChatTurnPorts['streamTextFn'],
      env: {} as NodeJS.ProcessEnv,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, 'read hello.txt')
      await waitForFrame(() => (lastFrame() ?? '').includes('workspace_read'))
      await waitForFrame(() => (lastFrame() ?? '').includes('saw it'))
      // Card row carries glyph + tool name; the answer carries the text reply.
      const frame = lastFrame() ?? ''
      expect(frame).toContain('✔ workspace_read')
      expect(frame).toContain('saw it')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('keeps the logo visible while startup notices render as dividers', async () => {
    const session = await openSession()
    const { lastFrame, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
        initialNotices={['janus: no model — set one with /model <id>.']}
      />,
    )
    try {
      await waitForFrame(() => (lastFrame() ?? '').includes('janus: no model'))
      const frame = lastFrame() ?? ''
      // Empty-state banner stays; the reminder sits in a divider card below it.
      expect(frame).toContain('██')
      expect(frame).toContain('○ janus: no model')
      expect(frame).toContain('──')
    } finally {
      unmount()
      await session.close()
    }
  })
})
