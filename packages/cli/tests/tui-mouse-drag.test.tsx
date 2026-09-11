/**
 * Constrained mouse drag end to end (capture on): an SGR press triggers a
 * CPR origin query, the reply anchors terminal→Ink cells, drag/release
 * resolve buffer content only, and release emits an OSC52 system copy.
 * Explicit opt-outs swallow the same bytes with no query and no copy.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render as renderInteractive } from 'ink'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  beforeEach(() => {
    vi.stubEnv('JANUS_MOUSE', undefined)
    vi.stubEnv('JANUS_NO_MOUSE', undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([{ x: 0, y: 0 }, { x: 3, y: -2 }])('copies only input by default with terminal origin %j', async (origin) => {
    cursorIntents.length = 0
    const session = await openSession()
    const rig = await mountApp(session)
    try {
      await waitForFrame(() => rig.writes.join('').includes(MOUSE_ENABLE))
      rig.stdin.write('test')
      await waitForFrame(() => rig.latestPaint().includes('test'))
      await tick()
      const caret = lastCaret()
      // The terminal position is the Ink cell plus the screen origin.
      const reply = { row: caret.y + origin.y + 1, col: caret.x + origin.x + 1 }
      const toTerm = (inkX: number, inkY: number): [number, number] => [
        inkX + origin.x + 1,
        inkY + origin.y + 1,
      ]
      const [pressX, pressY] = toTerm(caret.x - 4, caret.y)
      rig.stdin.write(`\x1b[<0;${pressX};${pressY}M`)
      await waitForFrame(() => rig.writes.join('').includes(CPR_QUERY))
      rig.stdin.write(`\x1b[${reply.row};${reply.col}R`)
      await tick(150)
      // Release below the frame: the endpoint clamps to the input end.
      const [dragX, dragY] = toTerm(caret.x + 10, caret.y + 3)
      rig.stdin.write(`\x1b[<32;${dragX};${dragY}M`)
      await tick()
      rig.stdin.write(`\x1b[<3;${dragX};${dragY}m`)
      await waitForFrame(() => rig.writes.join('').includes('52;c;dGVzdA=='))
      const copies = [...rig.writes.join('').matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)]
        .map((match) => Buffer.from(match[1]!, 'base64').toString('utf8'))
      expect(copies).toEqual(['test'])
      expect(rig.writes.join('').split(CPR_QUERY).length - 1).toBe(1)
      expect(rig.writes.join('')).not.toContain('[<')
      expect(rig.latestPaint()).toContain('test')
    } finally {
      await rig.done()
      await session.close()
    }
    expect(MOUSE_DISABLE).toContain('?1002l')
  })

  it.each(['JANUS_NO_MOUSE', 'JANUS_MOUSE'])('respects the %s opt-out with no query and no copy', async (flag) => {
    vi.stubEnv(flag, flag === 'JANUS_NO_MOUSE' ? '1' : '0')
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
