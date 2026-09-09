/**
 * Wheel/keyboard scrollback over a long reply: no mouse garbage in the
 * composer, tail-hidden indicator, and re-follow on the way back down.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render as renderInteractive } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { App } from '../src/tui/App.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import { MOUSE_DISABLE, MOUSE_ENABLE } from '../src/tui/scroll.js'

async function waitForFrame(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for frame: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const LONG_ANSWER = Array.from({ length: 30 }, (_, i) => `scroll-line-${i}`).join('\n')

async function openLongSession(stream?: AsyncGenerator<string>): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-wheel-')),
    model: 'm',
    apiKey: 'k',
    store: memoryConversationStore(),
    streamTextFn: (async () => ({
      textStream: stream ?? (async function* () { yield LONG_ANSWER })(),
    })) as ChatTurnPorts['streamTextFn'],
    env: {} as NodeJS.ProcessEnv,
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

describe('App scrollback', () => {
  it('enables mouse reporting on the actual TTY and restores it on unmount', async () => {
    const session = await openLongSession()
    const writes: string[] = []
    const stdout = Object.assign(new Writable({
      write(chunk, _encoding, done) { writes.push(chunk.toString()); done() },
    }), { isTTY: true, columns: 100, rows: 24 })
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() {}, ref() {}, unref() {},
    })
    const app = renderInteractive(
      <App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
        interactive: true, patchConsole: false, exitOnCtrlC: false },
    )
    try {
      await waitForFrame(() => writes.join('').includes(MOUSE_ENABLE))
      stdin.write('go')
      await new Promise((resolve) => setTimeout(resolve, 50))
      stdin.write('\r')
      await waitForFrame(() => writes.join('').includes('scroll-line-29'))
      writes.length = 0
      stdin.write('\x1b[<64;')
      stdin.write('1;1M')
      await waitForFrame(() => writes.join('').includes('↑'))
      expect(writes.join('')).not.toContain('[<64;')
    } finally {
      app.unmount()
      await app.waitUntilExit()
      app.cleanup()
      await session.close()
    }
    expect(writes.join('')).toContain(MOUSE_DISABLE)
  })

  it('anchors history while streaming and exposes every row of a completed answer', async () => {
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const session = await openLongSession((async function* () {
      yield LONG_ANSWER
      await gate
      yield '\n' + Array.from({ length: 20 }, (_, i) => `new-line-${i}`).join('\n')
    })())
    const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />)
    const visibleLines = (): string[] => (app.lastFrame() ?? '').split('\n').filter((line) => line.includes('scroll-line-'))
    try {
      app.stdin.write('go')
      await new Promise((resolve) => setTimeout(resolve, 50))
      app.stdin.write('\r')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('scroll-line-29'))
      app.stdin.write('\x1b[5~')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('↑'))
      const before = visibleLines()
      expect(before.length).toBeGreaterThan(0)
      resume()
      await waitForFrame(() => (app.lastFrame() ?? '').includes('message (/help)'))
      expect(visibleLines()).toEqual(before)

      app.stdin.write('\x1b[1;5H')
      await waitForFrame(() => (app.lastFrame() ?? '').includes('scroll-line-0'))
      const seen = new Set<string>()
      for (let tick = 0; tick < 25; tick += 1) {
        for (const match of (app.lastFrame() ?? '').matchAll(/(?:scroll|new)-line-\d+/g)) seen.add(match[0])
        app.stdin.write('\x1b[<65;1;1M')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      for (let i = 0; i < 30; i += 1) expect(seen.has(`scroll-line-${i}`)).toBe(true)
      for (let i = 0; i < 20; i += 1) expect(seen.has(`new-line-${i}`)).toBe(true)
      expect(app.lastFrame()).not.toContain('↑')
    } finally {
      resume()
      app.unmount()
      await session.close()
    }
  })

  it('scrolls a long reply with the wheel and re-follows on the way down', async () => {
    const session = await openLongSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      stdin.write('go')
      await new Promise((resolve) => setTimeout(resolve, 50))
      stdin.write('\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('scroll-line-29'))

      // Wheel up: older rows surface, the tail hides, no mouse bytes leak
      // into the composer.
      stdin.write('\x1b[<64;1;1M')
      await waitForFrame(() => (lastFrame() ?? '').includes('↑'))
      let frame = lastFrame() ?? ''
      expect(frame).not.toContain('scroll-line-29')
      expect(frame).not.toContain('[<64')
      expect(frame).toContain('PgDn')

      // Wheel down past the bottom re-follows the tail.
      stdin.write('\x1b[<65;1;1M\x1b[<65;1;1M\x1b[<65;1;1M\x1b[<65;1;1M')
      await waitForFrame(() => (lastFrame() ?? '').includes('scroll-line-29'))
      frame = lastFrame() ?? ''
      expect(frame).not.toContain('↑')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('pages with PgUp and jumps with Ctrl+End', async () => {
    const session = await openLongSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      stdin.write('go')
      await new Promise((resolve) => setTimeout(resolve, 50))
      stdin.write('\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('scroll-line-29'))

      stdin.write('\x1b[5~')
      await waitForFrame(() => (lastFrame() ?? '').includes('↑'))
      expect(lastFrame() ?? '').not.toContain('scroll-line-29')

      stdin.write('\x1b[1;5F')
      await waitForFrame(() => (lastFrame() ?? '').includes('scroll-line-29'))
    } finally {
      unmount()
      await session.close()
    }
  })
})
