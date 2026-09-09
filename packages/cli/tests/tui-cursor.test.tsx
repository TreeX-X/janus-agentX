/**
 * Cursor-ownership mechanism: the TUI positions the REAL native cursor on
 * the caret cell through Ink's official `useCursor` channel (opencode-style
 * renderer-owned cursor), so the OS IME candidate window follows the caret.
 * Hiding (`undefined`) is only used while busy/disabled, before the first
 * `measureElement` pass, or when the approval gate unmounts the composer.
 * The suite spies on the channel and asserts at least one real `{x,y}`
 * intent appears and that typing moves it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render as renderInteractive } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/tui/App.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import { displayWidth } from '../src/tui/composer-state.js'

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

async function openSession(): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: mkdtempSync(join(tmpdir(), 'janus-cursor-')),
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

describe('cursor ownership', () => {
  it('uses the same terminal origin for paints and cursor-only updates', { timeout: 15000 }, async () => {
    const session = await openSession()
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
    const latestPaint = (): string => stripVTControlCharacters(writes.filter((chunk) => chunk.includes('ctrl+d exit')).at(-1) ?? '')
    const expectPaintCaret = async (text: string, before: string): Promise<void> => {
      await waitForFrame(() => {
        const paint = latestPaint()
        const lines = paint.split('\n')
        const y = lines.findIndex((line) => line.includes(text))
        const line = lines[y] ?? ''
        const x = displayWidth(line.slice(0, line.indexOf(text)) + before)
        const intent = cursorIntents.at(-1) as { x: number; y: number } | undefined
        return y >= 0 && intent?.x === x && intent.y === y &&
          writes.join('').includes(`\x1b[${lines.length - 1 - y}A\x1b[${x + 1}G\x1b[?25h`)
      })
      expect(latestPaint().endsWith('\n')).toBe(true)
      expect(latestPaint().split('\n').length - 1).toBeLessThan(stdout.rows)
    }
    try {
      await expectPaintCaret('message (/help)', '')
      stdin.write('ab中')
      await expectPaintCaret('ab中', 'ab中')
      const previous = cursorIntents.at(-1) as { x: number; y: number }
      const visibleRows = latestPaint().split('\n').length - 1
      writes.length = 0
      stdin.write('\x1b[D')
      const distance = visibleRows - previous.y
      await waitForFrame(() => writes.join('').includes(
        `\x1b[${distance}B\x1b[1G\x1b[${distance}A\x1b[${previous.x - 1}G\x1b[?25h`,
      ))
      expect(writes.join('')).not.toContain('ab中')
      stdout.rows = 40
      stdout.emit('resize')
      await expectPaintCaret('ab中', 'ab')
      stdin.write('\x7f')
      await expectPaintCaret('a中', 'a')
      stdin.write('\x7f')
      await expectPaintCaret('› 中', '› ')
      stdin.write('\x1b[3~')
      await expectPaintCaret('message (/help)', '')
      stdout.rows = 16
      stdout.emit('resize')
      await waitForFrame(() => latestPaint().split('\n').length === 16)
      stdin.write('/')
      await expectPaintCaret('› /', '› /')
    } finally {
      app.unmount()
      await app.waitUntilExit()
      app.cleanup()
      await session.close()
    }
  })

  it('keeps cursor coordinates on the rendered text through editing and resize', { timeout: 15000 }, async () => {
    const session = await openSession()
    const app = render(
      <App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={() => {}} />,
    )
    const stdout = app.stdout as unknown as { rows: number; columns: number; emit: (event: string) => void }
    const expectCaret = async (text: string, before: string): Promise<void> => {
      await waitForFrame(() => {
        const lines = (app.lastFrame() ?? '').split('\n')
        const y = lines.findIndex((line) => line.includes(text))
        const line = lines[y] ?? ''
        const intent = cursorIntents.at(-1) as { x: number; y: number } | undefined
        return y >= 0 && intent?.y === y && intent.x === displayWidth(line.slice(0, line.indexOf(text)) + before)
      })
    }
    try {
      Object.defineProperty(stdout, 'rows', { configurable: true, value: 40 })
      stdout.emit('resize')
      await expectCaret('message (/help)', '')
      app.stdin.write('ab中')
      await expectCaret('ab中', 'ab中')
      app.stdin.write('\x1b[D')
      await expectCaret('ab中', 'ab')
      app.stdin.write('\n')
      await expectCaret('中', '')
      Object.defineProperty(stdout, 'rows', { configurable: true, value: 24 })
      Object.defineProperty(stdout, 'columns', { configurable: true, value: 60 })
      stdout.emit('resize')
      await waitForFrame(() => (app.lastFrame() ?? '').split('\n').length < 24)
      await expectCaret('中', '')
      expect((app.lastFrame() ?? '').split('\n').length).toBeLessThan(24)
    } finally {
      app.unmount()
      await session.close()
    }
  })

  it('positions the real native cursor on the caret (IME follows it)', { timeout: 15000 }, async () => {
    const session = await openSession()
    cursorIntents.length = 0
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
        onExit={() => {}}
      />,
    )
    try {
      await waitForFrame(() => (lastFrame() ?? '').includes('message (/help)'))
      // Post-layout `measureElement` pass: first frame hides, second frame
      // reports a real position (expect x=5,y=18 in the 80-col test env).
      await waitForFrame(() =>
        cursorIntents.some(
          (position) =>
            typeof position === 'object' &&
            position !== null &&
            Number.isFinite((position as { x: number }).x) &&
            Number.isFinite((position as { y: number }).y),
        ),
      )
      const defined = cursorIntents.filter(
        (position) => typeof position === 'object' && position !== null,
      ) as Array<{ x: number; y: number }>
      expect(defined.length).toBeGreaterThan(0)
      for (const position of defined) {
        expect(position.x).toBeGreaterThanOrEqual(0)
        expect(position.y).toBeGreaterThanOrEqual(0)
      }
      // Completion popup must not park the cursor: it stays defined.
      cursorIntents.length = 0
      stdin.write('/mo')
      await waitForFrame(() => (lastFrame() ?? '').includes('/model'))
      expect(
        cursorIntents.some((position) => typeof position === 'object' && position !== null),
      ).toBe(true)
      const baseX =
        (cursorIntents.filter((position) => typeof position === 'object' && position !== null) as Array<{
          x: number
          y: number
        }>).pop()?.x ?? 0
      // Typing must move the caret right (CJK-aware width, not parked).
      cursorIntents.length = 0
      stdin.write('ab')
      await waitForFrame(() =>
        cursorIntents.some(
          (position) =>
            typeof position === 'object' &&
            position !== null &&
            (position as { x: number }).x > baseX,
        ),
      )
      expect(
        cursorIntents.some((position) => typeof position === 'object' && position !== null),
      ).toBe(true)
    } finally {
      unmount()
      await session.close()
    }
  })

  it('dumps a caret snapshot on Ctrl+G for deviation reports', { timeout: 15000 }, async () => {
    const session = await openSession()
    const debugFile = join(mkdtempSync(join(tmpdir(), 'janus-caret-dbg-')), 'caret.log')
    const previous = process.env['JANUS_CURSOR_DEBUG_FILE']
    process.env['JANUS_CURSOR_DEBUG_FILE'] = debugFile
    try {
      const { lastFrame, stdin, unmount } = render(
        <App
          initialSession={session}
          host={{ createSession: async () => ({ error: 'unavailable in tests' }) }}
          onExit={() => {}}
        />,
      )
      try {
        await waitForFrame(() => (lastFrame() ?? '').includes('message (/help)'))
        stdin.write('ab')
        await waitForFrame(() => (lastFrame() ?? '').includes('ab'))
        stdin.write('\x07')
        await waitForFrame(() => {
          try {
            return readFileSync(debugFile, 'utf8').includes('"value":"ab"')
          } catch {
            return false
          }
        })
        const snapshot = JSON.parse(readFileSync(debugFile, 'utf8').trim().split('\n').pop()!) as {
          value: string
          caretDx: number
          caret: { intent: { x: number; y: number } | undefined } | null
        }
        expect(snapshot.value).toBe('ab')
        expect(snapshot.caret?.intent).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
      } finally {
        unmount()
      }
    } finally {
      if (previous === undefined) delete process.env['JANUS_CURSOR_DEBUG_FILE']
      else process.env['JANUS_CURSOR_DEBUG_FILE'] = previous
      rmSync(debugFile, { force: true })
      await session.close()
    }
  })
})
