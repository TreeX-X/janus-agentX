/**
 * Ink App smoke: real render frames + typed input over a stub transport.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
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
  it('shows tool results during the next model step and expands output while retaining the draft', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'janus-live-output-'))
    writeFileSync(join(workspace, 'data.txt'), Array.from({ length: 10 }, (_, i) => `file-line-${i}`).join('\n'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const session = await CliSession.create({ workspace, model: 'm', apiKey: 'k', store: memoryConversationStore(),
      streamTextFn: (async () => {
        calls += 1
        if (calls === 1) return { fullStream: (async function* () {
          yield { type: 'reasoning-delta', textDelta: 'Inspect data' }
          yield { type: 'tool-call', toolCallId: 'read-live', toolName: 'workspace_read', args: { workspaceId: 'cli', path: 'data.txt' } }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(), textStream: (async function* () {})() }
        return { fullStream: (async function* () {
          yield { type: 'reasoning-delta', textDelta: 'Reviewing results' }
          await gate
          yield { type: 'text-delta', textDelta: '# Result\n\n**Complete**\n\n```ts\nconst count = 10;\n```' }
          yield { type: 'finish', finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }
        })(), textStream: (async function* () {})() }
      }) as ChatTurnPorts['streamTextFn'], env: {},
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />)
    const stdout = app.stdout as unknown as { emit: (event: string) => void }
    Object.defineProperty(stdout, 'rows', { configurable: true, value: 45 })
    Object.defineProperty(stdout, 'columns', { configurable: true, value: 60 })
    stdout.emit('resize')
    try {
      await typeLine(app.stdin, 'inspect data')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('Reviewing results'))
      expect(app.lastFrame()).toContain('read › path: data.txt')
      expect(app.lastFrame()).toContain('file-line-0')
      expect(app.lastFrame()).not.toContain('file-line-8')
      await typeText(app.stdin, 'next draft')
      await press(app.stdin, '\x0f')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('file-line-8'))
      expect(app.lastFrame()).toContain('next draft')
      await press(app.stdin, '\x0f')
      release()
      await waitForFrame(() => (app.lastFrame() ?? '').includes('const count = 10;'))
      expect(app.lastFrame()).toContain('12 in / 8 out')
      expect(app.lastFrame()).not.toContain('**Complete**')
      expect(app.lastFrame()).toContain('next draft')
    } finally { release(); app.unmount(); await session.close() }
  })

  it('edits while busy and sends queued messages in order with conversation history', async () => {
    const session = await openSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sendTurn = session.sendTurn.bind(session)
    const send = vi.spyOn(session, 'sendTurn').mockImplementation(async (...args) => {
      if (args[0] === 'first') await gate
      return sendTurn(...args)
    })
    const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />)
    try {
      await typeLine(app.stdin, 'first')
      await waitForFrame(() => send.mock.calls.length === 1)
      await typeText(app.stdin, 'second')
      expect(app.lastFrame()).toContain('second')
      await press(app.stdin, '\r')
      await typeLine(app.stdin, 'third')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('queued (2)'))
      await typeText(app.stdin, 'unsent draft')
      expect(send).toHaveBeenCalledTimes(1)
      release()
      await waitForFrame(() => session.getActiveMessages().length === 6)
      expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(['first', 'second', 'third'])
      expect(session.getActiveMessages().map(({ content }) => content)).toEqual([
        'first', 'stub-answer', 'second', 'stub-answer', 'third', 'stub-answer',
      ])
      expect(app.lastFrame()).toContain('unsent draft')
      expect(app.lastFrame()).not.toContain('queued (')
      await press(app.stdin, '\r')
      await waitForFrame(() => session.getActiveMessages().length === 8)
    } finally {
      release()
      app.unmount()
      await session.close()
    }
  })

  it.each(['cancel', 'error'] as const)('restores pending messages and draft on %s', async (outcome) => {
    const session = await openSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = session.sendTurn.bind(session)
    const send = vi.spyOn(session, 'sendTurn').mockImplementation(async (...args) => {
      await gate
      if (outcome === 'error') throw new Error('transport failed')
      return original(...args)
    })
    const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />)
    try {
      await typeLine(app.stdin, 'first')
      await waitForFrame(() => send.mock.calls.length === 1)
      await typeLine(app.stdin, 'pending text')
      await typeText(app.stdin, 'draft text')
      if (outcome === 'cancel') await press(app.stdin, '\x03')
      release()
      await waitForFrame(() => (app.lastFrame() ?? '').includes('Pending messages restored'))
      expect(app.lastFrame()).toContain('pending text')
      expect(app.lastFrame()).toContain('draft text')
      expect(app.lastFrame()).not.toContain('queued (')
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      release()
      app.unmount()
      await session.close()
    }
  })

  it('preserves a busy slash command until the turn finishes', async () => {
    const session = await openSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = session.sendTurn.bind(session)
    const send = vi.spyOn(session, 'sendTurn').mockImplementation(async (...args) => {
      await gate
      return original(...args)
    })
    const id = session.getConversationId()
    const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />)
    try {
      await typeLine(app.stdin, 'first')
      await waitForFrame(() => send.mock.calls.length === 1)
      await typeLine(app.stdin, '/new')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('Commands are available'))
      expect(session.getConversationId()).toBe(id)
      expect(app.lastFrame()).toContain('/new')
      release()
      await waitForFrame(() => session.getActiveMessages().length === 2)
      await press(app.stdin, '\r')
      await waitForFrame(() => session.getConversationId() !== id)
    } finally {
      release()
      app.unmount()
      await session.close()
    }
  })

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

  it('opens the visual connect panel for /connect', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{
          createSession: async () => ({ error: 'unavailable in tests' }),
          testConnection: async () => ({ ok: true, models: [] }),
        }}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/connect')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ connect provider'))
      expect(lastFrame() ?? '').toContain('openai-compatible')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('interleaves thinking, tool cards, and text in stream order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-app-timeline-'))
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
              yield { type: 'reasoning-delta', textDelta: 'let me check' }
              yield { type: 'text-delta', textDelta: 'looking…' }
              yield { type: 'tool-call', toolCallId: 'c1', toolName: 'workspace_read', args: { workspaceId: 'cli', path: 'hello.txt' } }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        return { textStream: (async function* () { yield 'found it' })() }
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
      await waitForFrame(() => (lastFrame() ?? '').includes('found it'))
      // Rich tool rows can scroll earlier reasoning out of a 24-row terminal.
      await press(stdin, '\x1b[1;5H')
      const frame = lastFrame() ?? ''
      // Thinking first, then the tool it led to, then the follow-up answer.
      expect(frame).toContain('▸ thinking')
      expect(frame).toContain('let me check')
      expect(frame).toContain('✔ workspace_read')
      expect(frame.indexOf('let me check')).toBeLessThan(frame.indexOf('workspace_read'))
      await press(stdin, '\x1b[1;5F')
      expect(lastFrame() ?? '').toContain('found it')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('collapses thinking by default and expands on ctrl+t', async () => {
    const session = await CliSession.create({
      workspace: mkdtempSync(join(tmpdir(), 'janus-app-fold-')),
      model: 'm',
      apiKey: 'k',
      store: memoryConversationStore(),
      streamTextFn: (async () => ({
        fullStream: (async function* () {
          yield { type: 'reasoning-delta', textDelta: 'line-one\nline-two\nline-three and more' }
          yield { type: 'text-delta', textDelta: 'done' }
          yield { type: 'finish', finishReason: 'stop' }
        })(),
        textStream: (async function* () { })(),
      })) as ChatTurnPorts['streamTextFn'],
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
      await typeLine(stdin, 'hi')
      await waitForFrame(() => (lastFrame() ?? '').includes('done'))
      // Collapsed: gist + size hint, full body hidden.
      await waitForFrame(() => (lastFrame() ?? '').includes('▸ thinking'))
      expect(lastFrame() ?? '').toContain('line-one')
      expect(lastFrame() ?? '').not.toContain('line-three')
      await press(stdin, '')
      await waitForFrame(() => (lastFrame() ?? '').includes('line-three'))
      await press(stdin, '')
      await waitForFrame(() => !(lastFrame() ?? '').includes('line-three'))
    } finally {
      unmount()
      await session.close()
    }
  })

  it('renders file previews under mutation tool cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-app-preview-'))
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
              yield {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'workspace_create',
                args: { workspaceId: 'cli', path: 'new.txt', content: 'hello preview\n' },
              }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        return { textStream: (async function* () { yield 'created' })() }
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
      await typeLine(stdin, 'create new.txt')
      await waitForFrame(() => (lastFrame() ?? '').includes('✔ workspace_create'))
      const frame = lastFrame() ?? ''
      // Outcome caption plus new-file content preview, inline under the card.
      expect(frame).toContain('└ new.txt, sha256=')
      expect(frame).toContain('+hello preview')
    } finally {
      unmount()
      await session.close()
    }
  })
})
