/**
 * Reasoning effort (CodeX parity): parsing, precedence, and wire mapping.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import {
  DEFAULT_EFFORT,
  EFFORT_META,
  effortPickerRows,
  effortProviderOptions,
  formatEffortList,
  normalizeEffort,
  parseEffortPickerInput,
  resolveEffortArg,
  wireEffort,
} from '../src/effort.js'
import { parseCatalog } from '../src/providers.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn
}

describe('effort helpers', () => {
  it('normalizes levels case-insensitively and rejects unknown', () => {
    expect(normalizeEffort('HIGH')).toBe('high')
    expect(normalizeEffort(' ultra ')).toBe('ultra')
    expect(normalizeEffort('nope')).toBeUndefined()
    expect(DEFAULT_EFFORT).toBe('medium')
  })

  it('clamps ultra to xhigh on the wire and namespaces providerOptions', () => {
    expect(wireEffort('ultra')).toBe('xhigh')
    expect(wireEffort('high')).toBe('high')
    expect(effortProviderOptions('high')).toEqual({
      providerOptions: { openai: { reasoningEffort: 'high' } },
    })
    expect(effortProviderOptions('ultra')).toEqual({
      providerOptions: { openai: { reasoningEffort: 'xhigh' } },
    })
  })

  it('parses --effort for chat and tui', () => {
    expect(parseArgs(['chat', '--effort', 'high', 'hi'], '/b').chat).toMatchObject({ effort: 'high' })
    expect(parseArgs(['tui', '--effort', 'xhigh'], '/b').tui).toMatchObject({ effort: 'xhigh' })
    expect(parseArgs(['chat', '--effort', 'nope', 'hi'], '/b').error).toMatch(/Invalid --effort/)
    expect(parseArgs(['chat', '--reasoning-effort', 'low', 'hi'], '/b').error).toMatch(/Unknown flag/)
  })

  it('resolves picker numbers/names and formats the numbered list', () => {
    expect(EFFORT_META).toHaveLength(8)
    expect(resolveEffortArg('5')).toBe('high')
    expect(resolveEffortArg('HIGH')).toBe('high')
    expect(resolveEffortArg('nope')).toBeUndefined()
    expect(parseEffortPickerInput('')).toEqual({ action: 'cancel' })
    expect(parseEffortPickerInput('q')).toEqual({ action: 'cancel' })
    expect(parseEffortPickerInput('5')).toEqual({ action: 'switch', level: 'high' })
    expect(parseEffortPickerInput('xhigh')).toEqual({ action: 'switch', level: 'xhigh' })
    expect(parseEffortPickerInput('nope').action).toBe('error')
    const rows = effortPickerRows('medium')
    expect(rows).toHaveLength(8)
    expect(rows.find((row) => row.includes('medium'))).toMatch(/^\*/)
    expect(formatEffortList('medium')).toContain('switch with /effort <level|number>')
  })

  it('keeps effort in the provider catalog round-trip', () => {
    const catalog = parseCatalog({
      version: 1,
      providers: [{ id: 'a', models: ['m'], effort: 'high' }],
      defaultProvider: 'a',
      defaultEffort: 'low',
    })
    expect(catalog.defaultEffort).toBe('low')
    expect(catalog.providers[0].effort).toBe('high')
    expect(parseCatalog({ version: 1, providers: [{ id: 'a' }], defaultEffort: 'nope' }).defaultEffort).toBeUndefined()
  })
})

describe('CliSession effort', () => {
  it('defaults to medium and follows flag > env > file > provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-effort-'))
    const base = {
      workspace: dir,
      store: memoryConversationStore(),
      streamTextFn: textStub(),
      env: {} as NodeJS.ProcessEnv,
    }
    const def = await CliSession.create({ ...base, model: 'm', apiKey: 'k' })
    if (isSessionValidationError(def)) throw new Error(def.message)
    expect(def.getEffort()).toBe('medium')
    await def.close()

    const fromEnv = await CliSession.create({ ...base, model: 'm', apiKey: 'k', env: { JANUS_EFFORT: 'high' } })
    if (isSessionValidationError(fromEnv)) throw new Error(fromEnv.message)
    expect(fromEnv.getEffort()).toBe('high')
    await fromEnv.close()

    const fromFlag = await CliSession.create({ ...base, model: 'm', apiKey: 'k', effort: 'low', env: { JANUS_EFFORT: 'high' } })
    if (isSessionValidationError(fromFlag)) throw new Error(fromFlag.message)
    expect(fromFlag.getEffort()).toBe('low')
    await fromFlag.close()

    const fromFile = await CliSession.create({
      ...base,
      model: 'm',
      apiKey: 'k',
      catalog: parseCatalog({ version: 1, providers: [{ id: 'a', models: ['m'], effort: 'high' }], defaultEffort: 'low' }),
    })
    if (isSessionValidationError(fromFile)) throw new Error(fromFile.message)
    expect(fromFile.getEffort()).toBe('low')
    await fromFile.close()
  })

  it('rejects unknown flag/env effort and switches via setEffort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-effort-bad-'))
    const badFlag = await CliSession.create({ workspace: dir, model: 'm', apiKey: 'k', effort: 'nope' })
    expect(isSessionValidationError(badFlag) && badFlag.code).toBe('unknown-effort')

    const badEnv = await CliSession.create({ workspace: dir, model: 'm', apiKey: 'k', env: { JANUS_EFFORT: 'nope' } })
    expect(isSessionValidationError(badEnv) && badEnv.code).toBe('unknown-effort')

    const session = await CliSession.create({ workspace: dir, model: 'm', apiKey: 'k', store: memoryConversationStore(), streamTextFn: textStub(), env: {} })
    if (isSessionValidationError(session)) throw new Error(session.message)
    expect(() => session.setEffort('nope')).toThrow(/unknown effort/)
    session.setEffort('HIGH')
    expect(session.getEffort()).toBe('high')
    await session.close()
  })

  it('forwards effort to the model transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-effort-wire-'))
    let seen: Record<string, unknown> | undefined
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      effort: 'high',
      store: memoryConversationStore(),
      streamTextFn: (async (opts: Record<string, unknown>) => {
        seen = opts
        return { textStream: (async function* () { yield 'ok' })() }
      }) as StreamFn,
      env: {},
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    await session.sendTurn('hi')
    // Effort reaches the core stream adapter; the OpenAI mapping happens in model-stream.
    expect(seen).toMatchObject({ effort: 'high' })
    await session.close()
  })
})
