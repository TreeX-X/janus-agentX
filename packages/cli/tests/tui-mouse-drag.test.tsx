/**
 * Constrained mouse drag end to end (capture on): an SGR press triggers a
 * CPR origin query, the reply anchors terminal→Ink cells, drag/release
 * resolve buffer content only, and release emits an OSC52 system copy.
 * Without the flag the same bytes are swallowed with no query and no copy.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render as renderInteractive } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/tui/App.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import { CPR_QUERY, MOUSE_DISABLE, MOUSE_ENABLE } from '../src/tui/scroll.js'

const { cursorIntents } = vi.hoisted(() => ({ cursorIntents: [] as unknown[] }))

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  return {
    ...actual,
    useCursor: () => {
      const real = actual.useCursor()
      return {
        setCursorPosition: (position: unknown) => {
          cursorIntents.push(position)
          real.setCursorPosition(position as never)
        },
      }
    },
  }
})

async function waitForFrame(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const tick = async (ms = 90): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function openSession(): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-drag-')),
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

const lastCaret = (): { x: number; y: number } => {
  const defined = cursorIntents.filter((position) => typeof position === 'object' && position !== null) as Array<{ x: number; y: number }>
  const caret = defined.at(-1)
  if (!caret) throw new Error('no caret intent observed')
  return caret
}

describe('constrained mouse drag', () => {
  it('queries CPR once, maps the drag to content, and auto-copies on release', async () => {
    const previous = process.env['JANUS_MOUSE']
    process.env['JANUS_MOUSE'] = '1'
    cursorIntents.length = 0
    const session = await openSession()
    const rig = await mountApp(session)
    try {
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_ENABLE))
      rig.stdin.write('hi')
      await waitForFrame(() => rig.latestPaint().includes('hi'))
      await tick()
      const caret = lastCaret()
      // Reply with the caret's own position (zero offset): every computed
      // terminal cell stays a valid 1-based SGR coordinate while the full
      // request→map→copy loop is exercised exactly as in production.
      const reply = { row: caret.y + 1, col: caret.x + 1 }
      const toTerm = (inkX: number, inkY: number): [number, number] => [
        inkX - (reply.col - 1 - caret.x) + 1,
        inkY - (reply.row - 1 - caret.y) + 1,
      ]
      // Press on 'h' (caret sits after 'i', two cells right of it).
      const [pressX, pressY] = toTerm(caret.x - 2, caret.y)
      rig.stdin.write(`\x1b[<0;${pressX};${pressY}M`)
      await waitForFrame(() => rig.writes.join('').includes(CPR_QUERY))
      rig.stdin.write(`\x1b[${reply.row};${reply.col}R`)
      await tick(150)
      // Drag onto the caret cell (offset 2) and release: selection [0,2).
      const [dragX, dragY] = toTerm(caret.x, caret.y)
      rig.stdin.write(`\x1b[<32;${dragX};${dragY}M`)
      await tick()
      rig.stdin.write(`\x1b[<3;${dragX};${dragY}m`)
      // 'hi' base64s to 'aGk=': the release carried buffer content only.
      await waitForFrame(() => rig.writes.join('').includes('52;c;aGk='))
      expect(rig.writes.join('')).not.toContain('[<')
      expect(rig.latestPaint()).toContain('hi')
    } finally {
      await rig.done()
      await session.close()
      if (previous === undefined) delete process.env['JANUS_MOUSE']
      else process.env['JANUS_MOUSE'] = previous
    }
    expect(MOUSE_DISABLE).toContain('?1002l')
  })

  it('swallows the same bytes by default with no query and no copy', async () => {
    cursorIntents.length = 0
    const session = await openSession()
    const rig = await mountApp(session)
    try {
      rig.stdin.write('hi')
      await waitForFrame(() => rig.latestPaint().includes('hi'))
      rig.writes.length = 0
      rig.stdin.write('\x1b[<0;40;20M')
      await tick(150)
      rig.stdin.write('\x1b[<32;45;20M')
      await tick(150)
      rig.stdin.write('\x1b[<3;45;20m')
      await tick(150)
      expect(rig.writes.join('')).not.toContain(CPR_QUERY)
      expect(rig.writes.join('')).not.toContain('52;c;')
      expect(rig.writes.join('')).not.toContain('[<')
      expect(rig.latestPaint()).toContain('hi')
    } finally {
      await rig.done()
      await session.close()
    }
  })
})
