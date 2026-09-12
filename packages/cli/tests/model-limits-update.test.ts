/**
 * Refresh-script comparison core: unsafe/low/uncovered classes and the
 * safe auto-lower rule. Fixtures only, no network.
 */
import { describe, expect, it } from 'vitest'
import { applySafeLower, diffTable, resolvePrefix } from '../../scripts/model-limits-diff.mjs'

const PREFIXES = [
  { prefix: 'gpt-5.6', contextWindow: 1_050_000, maxOutputTokens: 128_000 },
  { prefix: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 32_768 },
  { prefix: 'deepseek', contextWindow: 64_000, maxOutputTokens: 8_000 },
]

describe('diffTable', () => {
  it('flags table-above-documented as unsafe with the matching prefix', () => {
    const diff = diffTable(PREFIXES, [
      { id: 'openai/gpt-5-chat', model: 'gpt-5-chat', context: 400_000 },
      { id: 'openai/gpt-5.6-sol', model: 'gpt-5.6-sol', context: 272_000 },
    ])
    expect(diff.unsafe).toEqual([
      { id: 'openai/gpt-5.6-sol', documented: 272_000, resolved: 1_050_000, prefix: 'gpt-5.6' },
    ])
    expect(diff.low).toEqual([])
  })

  it('reports table-below-documented as reviewable low and unknown ids as uncovered', () => {
    const diff = diffTable(PREFIXES, [
      { id: 'deepseek/deepseek-v4', model: 'deepseek-v4', context: 1_000_000 },
      { id: 'x/new-model', model: 'new-model', context: 512_000 },
      { id: 'broken/no-limit', model: 'no-limit', context: 0 },
    ])
    expect(diff.low).toEqual([
      { id: 'deepseek/deepseek-v4', documented: 1_000_000, resolved: 64_000, prefix: 'deepseek' },
    ])
    expect(diff.uncovered).toEqual([{ id: 'x/new-model', documented: 512_000 }])
    expect(diff.unsafe).toEqual([])
  })
})

describe('applySafeLower', () => {
  it('lowers only unsafe floors to the documented minimum, never raises', () => {
    const diff = diffTable(PREFIXES, [
      { id: 'openai/gpt-5.6-sol', model: 'gpt-5.6-sol', context: 272_000 },
      { id: 'deepseek/deepseek-v4', model: 'deepseek-v4', context: 1_000_000 },
    ])
    const { rows, changes } = applySafeLower(PREFIXES, diff)
    expect(changes).toEqual([{ prefix: 'gpt-5.6', from: 1_050_000, to: 272_000 }])
    expect(rows.find((row) => row.prefix === 'gpt-5.6')?.contextWindow).toBe(272_000)
    expect(rows.find((row) => row.prefix === 'deepseek')?.contextWindow).toBe(64_000)
    // Longest-prefix mirror matches the runtime resolver.
    expect(resolvePrefix(PREFIXES, 'GPT-5.6-SOL')?.prefix).toBe('gpt-5.6')
  })
})
