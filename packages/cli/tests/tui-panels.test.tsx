/**
 * Ink overlay panels: Ctrl+P palette + visual provider setup.
 * Real render frames over a stub transport; key material must never surface.
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
import type { TestConnectionFn } from '../src/connect.js'

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
    workspace: mkdtempSync(join(tmpdir(), 'janus-panels-')),
    catalog: {
      version: 1,
      providers: [
        { id: 'ds', name: 'DeepSeek', baseURL: 'http://ds/v1' },
        { id: 'oa', name: 'OpenAI', baseURL: 'http://oa/v1', models: ['m-oa'] },
      ],
    },
    store: memoryConversationStore(),
    streamTextFn: (async () => ({
      textStream: (async function* () { yield 'stub-answer' })(),
    })) as ChatTurnPorts['streamTextFn'],
    env: {} as NodeJS.ProcessEnv,
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

function testHost(testConnection: TestConnectionFn): {
  createSession: () => Promise<{ error: string }>
  testConnection: TestConnectionFn
} {
  return {
    createSession: async () => ({ error: 'unavailable in tests' }),
    testConnection,
  }
}

async function typeLine(stdin: { write: (data: string) => void }, text: string): Promise<void> {
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

describe('palette', () => {
  it('opens on Ctrl+P, filters, and runs a command inline', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App initialSession={session} host={testHost(async () => ({ ok: true, models: [] }))} onExit={() => {}} />,
    )
    try {
      await press(stdin, '')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ command palette'))
      await typeText(stdin, 'stat')
      await waitForFrame(() => (lastFrame() ?? '').includes('Show status'))
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('provider: ds'))
    } finally {
      unmount()
      await session.close()
    }
  })

  it('closes on Esc without side effects', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App initialSession={session} host={testHost(async () => ({ ok: true, models: [] }))} onExit={() => {}} />,
    )
    try {
      await press(stdin, '')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ command palette'))
      await press(stdin, '\x1B')
      await waitForFrame(() => !(lastFrame() ?? '').includes('◇ command palette'))
      expect(lastFrame() ?? '').not.toContain('provider: ds · model')
    } finally {
      unmount()
      await session.close()
    }
  })
})

describe('panels', () => {
  it('walks pick -> masked key -> probe -> model pick without leaking the key', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: true, models: ['m-x', 'm-y'] }))}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/connect')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ connect provider'))
      // Arrow down moves from ds to oa: the key step must name oa.
      await press(stdin, '[B')
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('API key for'))
      expect(lastFrame() ?? '').toContain('oa')
      await typeText(stdin, 'sk-panel-secret')
      await waitForFrame(() => (lastFrame() ?? '').includes('•'))
      expect(lastFrame() ?? '').not.toContain('sk-panel-secret')
      await press(stdin, '\r')
      // oa is closed-world (models: [m-oa]): no model pick, straight to done.
      await waitForFrame(() => (lastFrame() ?? '').includes('✓ oa'))
      expect(lastFrame() ?? '').not.toContain('sk-panel-secret')
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('connected: oa'))
      const frame = lastFrame() ?? ''
      expect(frame).not.toContain('sk-panel-secret')
      expect(frame).not.toContain('◇ connect provider')
      expect(session.getProviderId()).toBe('oa')
      expect(session.getApiKeySource()).toBe('auth.json')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('adds a brand-new provider through the panel fields', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: false, models: [], error: 'HTTP 401' }))}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/connect')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ connect provider'))
      // Filter everything out so only "+ Add new provider…" remains.
      await typeText(stdin, 'zzz-no-match')
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('new provider id:'))
      await typeLine(stdin, 'nw')
      await waitForFrame(() => (lastFrame() ?? '').includes('baseURL for'))
      await press(stdin, '\r') // empty = OpenAI default
      await waitForFrame(() => (lastFrame() ?? '').includes('API key for'))
      await typeLine(stdin, 'sk-brand-new')
      // Probe fails: warning lands in the discussion, setup is still saved.
      await waitForFrame(() => (lastFrame() ?? '').includes('connection test failed: HTTP 401'))
      await waitForFrame(() => (lastFrame() ?? '').includes('✓ nw'))
      expect(session.getCatalog().providers.map((entry) => entry.id)).toContain('nw')
      expect(session.getProviderId()).toBe('nw')
      const frame = lastFrame() ?? ''
      expect(frame).not.toContain('sk-brand-new')
      await press(stdin, '\r')
      await waitForFrame(() => !(lastFrame() ?? '').includes('◇ connect provider'))
    } finally {
      unmount()
      await session.close()
    }
  })

  it('/connect <id> jumps straight to the key step', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: true, models: [] }))}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/connect ds')
      await waitForFrame(() => (lastFrame() ?? '').includes('API key for'))
      expect(lastFrame() ?? '').toContain('ds')
    } finally {
      unmount()
      await session.close()
    }
  })

  it('pages discussion scrollback with PgUp/PgDn', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: true, models: [] }))}
        onExit={() => {}}
      />,
    )
    const frameHas = (text: string): boolean => (lastFrame() ?? '').includes(text)
    try {
      // One /status run per provider: the two outputs overflow the viewport,
      // so only the newest run stays visible. Markers differ per provider
      // because identical /status text cannot tell old from new.
      await typeLine(stdin, '/status')
      await waitForFrame(() => frameHas('config:'))
      await typeLine(stdin, '/provider oa')
      await waitForFrame(() => frameHas('provider switched: oa'))
      await typeLine(stdin, '/status')
      await waitForFrame(() => frameHas('provider: oa'))
      expect(frameHas('provider: ds')).toBe(false)
      // PgUp pages back to the older run and raises the tail-hidden badge.
      await press(stdin, '[5~')
      await press(stdin, '[5~')
      await press(stdin, '[5~')
      await waitForFrame(() => frameHas('↑'))
      expect(frameHas('provider: ds')).toBe(true)
      // PgDn past the bottom re-follows the tail.
      await press(stdin, '[6~')
      await press(stdin, '[6~')
      await press(stdin, '[6~')
      await waitForFrame(() => !frameHas('↑'))
      expect(frameHas('provider: oa')).toBe(true)
    } finally {
      unmount()
      await session.close()
    }
  })

  it('removes a provider with Del + inline confirm (Esc cancels)', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: true, models: [] }))}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/connect')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ connect provider'))
      await press(stdin, '[B') // highlight oa
      await press(stdin, '[3~') // arm removal
      await waitForFrame(() => (lastFrame() ?? '').includes('delete “oa”?'))
      await press(stdin, '') // cancel first: oa must survive
      await waitForFrame(() => !(lastFrame() ?? '').includes('delete “oa”?'))
      expect(session.listProviders().entries.map((entry) => entry.id)).toEqual(['ds', 'oa'])
      await press(stdin, '[3~') // arm again
      await waitForFrame(() => (lastFrame() ?? '').includes('delete “oa”?'))
      await press(stdin, '\r') // confirm
      await waitForFrame(() => (lastFrame() ?? '').includes('provider removed: oa'))
      expect(session.listProviders().entries.map((entry) => entry.id)).toEqual(['ds'])
    } finally {
      unmount()
      await session.close()
    }
  })

  it('switches approval mode through the option panel', async () => {
    const session = await openSession()
    const { lastFrame, stdin, unmount } = render(
      <App
        initialSession={session}
        host={testHost(async () => ({ ok: true, models: [] }))}
        onExit={() => {}}
      />,
    )
    try {
      await typeLine(stdin, '/approval')
      await waitForFrame(() => (lastFrame() ?? '').includes('◇ approval mode'))
      expect(lastFrame() ?? '').toContain('per-action')
      await press(stdin, '[B') // move to per-action
      await press(stdin, '\r')
      await waitForFrame(() => (lastFrame() ?? '').includes('approval: per-action'))
      expect(session.getApprovalMode()).toBe('per-action')
      expect(lastFrame() ?? '').toContain('per-action')
    } finally {
      unmount()
      await session.close()
    }
  })
})
