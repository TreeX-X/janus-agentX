/**
 * Built-in model window table: precedence, matching, and session wiring.
 * Real CliSession over memory store, stub transport (no network).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FALLBACK_MODEL_LIMITS, resolveModelLimits } from '../src/model-limits.js'
import { MODEL_LIMIT_ROWS } from '../src/model-limits.table.js'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import { parseCatalog } from '../src/providers.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn
}

describe('resolveModelLimits', () => {
  it('resolves known families case-insensitively without estimating', () => {
    expect(resolveModelLimits({ modelId: 'gpt-4o' })).toMatchObject({
      limits: { contextWindow: 128_000, maxOutputTokens: 16_384 },
      source: 'builtin',
      estimated: false,
    })
    expect(resolveModelLimits({ modelId: 'GPT-4O-MINI' }).limits.contextWindow).toBe(128_000)
    expect(resolveModelLimits({ modelId: 'deepseek-chat' })).toMatchObject({
      limits: { contextWindow: 64_000, maxOutputTokens: 8_000 },
      source: 'builtin',
    })
  })

  it('prefers the longest matching family prefix', () => {
    expect(resolveModelLimits({ modelId: 'gpt-4.1-mini' }).limits.contextWindow).toBe(1_000_000)
    expect(resolveModelLimits({ modelId: 'gpt-5.6-sol' }).limits).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    })
    expect(resolveModelLimits({ modelId: 'gpt-5-chat' }).limits.contextWindow).toBe(400_000)
    expect(resolveModelLimits({ modelId: 'o1-mini' }).limits.contextWindow).toBe(128_000)
    expect(resolveModelLimits({ modelId: 'o1-preview' }).limits.contextWindow).toBe(200_000)
    expect(resolveModelLimits({ modelId: 'kimi-k3' }).limits.contextWindow).toBe(1_050_000)
    expect(resolveModelLimits({ modelId: 'kimi-k2-0711-preview' }).limits.contextWindow).toBe(128_000)
    expect(resolveModelLimits({ modelId: 'kimi-k2.5' }).limits.contextWindow).toBe(256_000)
    expect(resolveModelLimits({ modelId: 'qwen3-coder-480b' }).limits.contextWindow).toBe(256_000)
    expect(resolveModelLimits({ modelId: 'qwen2.5-32b' }).limits.contextWindow).toBe(32_000)
    expect(resolveModelLimits({ modelId: 'deepseek-v4-pro' }).limits.contextWindow).toBe(1_000_000)
    expect(resolveModelLimits({ modelId: 'deepseek-chat' }).limits.contextWindow).toBe(64_000)
    expect(resolveModelLimits({ modelId: 'doubao-seed-1-6-250615' }).limits.contextWindow).toBe(256_000)
    expect(resolveModelLimits({ modelId: 'doubao-seed-2-0-lite' }).limits.contextWindow).toBe(128_000)
  })

  it('keeps the curated table well-formed', () => {
    expect(MODEL_LIMIT_ROWS.length).toBeGreaterThan(0)
    const prefixes = MODEL_LIMIT_ROWS.map((row) => row.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const row of MODEL_LIMIT_ROWS) {
      expect(row.prefix).toBe(row.prefix.toLowerCase())
      expect(Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0).toBe(true)
      expect(Number.isSafeInteger(row.maxOutputTokens) && row.maxOutputTokens > 0).toBe(true)
    }
  })

  it('falls back conservatively for unknown ids and marks the guess', () => {
    expect(resolveModelLimits({ modelId: 'm' })).toEqual({
      limits: { ...FALLBACK_MODEL_LIMITS },
      source: 'fallback',
      estimated: true,
    })
    expect(resolveModelLimits({})).toMatchObject({ source: 'fallback', estimated: true })
  })

  it('lets config overrides win per field over the table', () => {
    expect(
      resolveModelLimits({ modelId: 'gpt-4o', override: { contextWindow: 1_000_000 } }),
    ).toMatchObject({
      limits: { contextWindow: 1_000_000, maxOutputTokens: 16_384 },
      source: 'override',
      estimated: false,
    })
    expect(
      resolveModelLimits({ modelId: 'm', override: { maxOutputTokens: 4_096 } }),
    ).toMatchObject({
      limits: { contextWindow: FALLBACK_MODEL_LIMITS.contextWindow, maxOutputTokens: 4_096 },
      source: 'override',
    })
  })

  it('ignores non-positive override values', () => {
    expect(
      resolveModelLimits({ modelId: 'gpt-4o', override: { contextWindow: 0, maxOutputTokens: -5 } }),
    ).toMatchObject({ source: 'builtin', estimated: false })
    expect(
      resolveModelLimits({ modelId: 'm', override: { contextWindow: 'huge' } }),
    ).toMatchObject({ source: 'fallback', estimated: true })
  })
})

describe('CliSession context window', () => {
  async function openSession(catalog: Parameters<typeof parseCatalog>[0], model: string) {
    const session = await CliSession.create({
      workspace: mkdtempSync(join(tmpdir(), 'janus-limits-')),
      model,
      apiKey: 'k',
      store: memoryConversationStore(),
      catalog: parseCatalog(catalog),
      streamTextFn: textStub(),
      env: {} as NodeJS.ProcessEnv,
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    return session
  }

  it('reports the built-in window for known models', async () => {
    const session = await openSession(
      { providers: [{ id: 'a', models: ['gpt-4o'] }] },
      'gpt-4o',
    )
    expect(session.getContextWindow()).toEqual({ value: 128_000, estimated: false })
    await session.close()
  })

  it('reports an estimated fallback for unknown models', async () => {
    const session = await openSession(
      { providers: [{ id: 'a', models: ['m'] }] },
      'm',
    )
    expect(session.getContextWindow()).toEqual({ value: FALLBACK_MODEL_LIMITS.contextWindow, estimated: true })
    await session.close()
  })

  it('lets provider catalog overrides win over the table', async () => {
    const session = await openSession(
      { providers: [{ id: 'a', models: ['gpt-4o'], contextWindow: 500_000 }] },
      'gpt-4o',
    )
    expect(session.getContextWindow()).toEqual({ value: 500_000, estimated: false })
    await session.close()
  })

  it('drops invalid catalog overrides back to the table', async () => {
    const session = await openSession(
      { providers: [{ id: 'a', models: ['gpt-4o'], contextWindow: -1 }] },
      'gpt-4o',
    )
    expect(session.getContextWindow()).toEqual({ value: 128_000, estimated: false })
    await session.close()
  })
})
