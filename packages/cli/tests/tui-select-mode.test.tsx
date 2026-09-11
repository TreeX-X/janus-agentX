/**
 * Native box-selection mode: Ctrl+B releases mouse capture for terminal
 * drag-selection (badge on the footer), Ctrl+C/Esc only leave the mode
 * without touching the draft, and JANUS_NO_MOUSE short-circuits the toggle.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render as renderInteractive } from 'ink'
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
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const tick = async (ms = 80): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function openSession(): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-select-mode-')),
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

interface Rig {
  writes: string[]
  stdin: PassThrough & { isTTY: boolean; setRawMode(): void; ref(): void; unref(): void }
  latestPaint: () => string
  done: () => Promise<void>
}

async function mountApp(session: CliSession): Promise<Rig> {
  const writes: string[] = []
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) { writes.push(chunk.toString()); done() },
  }), { isTTY: true, columns: 100, rows: 24 })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  }) as Rig['stdin']
  const app = renderInteractive(
    <App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: true, patchConsole: false, exitOnCtrlC: false },
  )
  await waitForFrame(() => writes.join('').includes(MOUSE_ENABLE))
  return {
    writes,
    stdin,
    latestPaint: () => stripVTControlCharacters(writes.filter((chunk) => chunk.includes('Cmds')).at(-1) ?? ''),
    done: async () => {
      app.unmount()
      await app.waitUntilExit()
      app.cleanup()
    },
  }
}

describe('select mode', () => {
  it('toggles capture on Ctrl+B and leaves the draft alone on Ctrl+C/Esc', async () => {
    const session = await openSession()
    const rig = await mountApp(session)
    try {
      rig.stdin.write('draft-here')
      await tick(150)
      rig.writes.length = 0

      // Enter: capture released, badge visible, draft untouched.
      // (The badge is the full `框选·Esc退出` segment: the left bar also
      // carries a permanent `[Ctrl+B] 框选` hint.)
      rig.stdin.write('\x02')
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_DISABLE))
      await waitForFrame(() => rig.latestPaint().includes('框选·Esc退出'))
      expect(rig.latestPaint()).toContain('draft-here')
      rig.writes.length = 0

      // Copy-intent Ctrl+C only leaves the mode: draft survives, badge gone.
      rig.stdin.write('\x03')
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_ENABLE))
      await waitForFrame(() => {
        const paint = rig.latestPaint()
        return paint !== '' && !paint.includes('框选·Esc退出')
      })
      expect(rig.latestPaint()).toContain('draft-here')

      // Re-enter and leave via Esc with the same guarantees.
      rig.stdin.write('\x02')
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_DISABLE))
      rig.writes.length = 0
      rig.stdin.write('\x1b')
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_ENABLE))
      await waitForFrame(() => {
        const paint = rig.latestPaint()
        return paint !== '' && !paint.includes('框选·Esc退出')
      })
      expect(rig.latestPaint()).toContain('draft-here')
    } finally {
      await rig.done()
      await session.close()
    }
  })

  it('short-circuits the toggle when capture was never taken', async () => {
    const previous = process.env['JANUS_NO_MOUSE']
    process.env['JANUS_NO_MOUSE'] = '1'
    const session = await openSession()
    try {
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
        await tick(200)
        expect(writes.join('')).not.toContain(MOUSE_ENABLE)
        stdin.write('\x02')
        await waitForFrame(() => writes.join('').includes('Native selection is already active'))
        expect(writes.join('')).not.toContain(MOUSE_DISABLE)
      } finally {
        app.unmount()
        await app.waitUntilExit()
        app.cleanup()
      }
    } finally {
      if (previous === undefined) delete process.env['JANUS_NO_MOUSE']
      else process.env['JANUS_NO_MOUSE'] = previous
      await session.close()
    }
  })
})
