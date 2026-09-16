import { describe, expect, it } from 'vitest'
import {
  estimateOutputTokens,
  fitItemsToBudget,
  parseOutputTokenBudget,
} from '../src/main/agent/runtime/tools/output-budget'

describe('output token budgets', () => {
  it('estimates ASCII at four chars per token and non-ASCII conservatively', () => {
    expect(estimateOutputTokens('')).toBe(0)
    expect(estimateOutputTokens('abcd')).toBe(1)
    expect(estimateOutputTokens('abcde')).toBe(2)
    expect(estimateOutputTokens('中文')).toBe(2)
    expect(estimateOutputTokens('ab中文')).toBe(3)
  })

  it('keeps every item when the budget covers the text', () => {
    const fitted = fitItemsToBudget(['a', 'b'], (line) => line, 10_000)
    expect(fitted).toEqual({ items: ['a', 'b'], truncated: false })
  })

  it('drops trailing items under a tight budget but keeps at least one', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index} with padding text`)
    const fitted = fitItemsToBudget(lines, (line) => line, 10)
    expect(fitted.truncated).toBe(true)
    expect(fitted.items.length).toBeGreaterThanOrEqual(1)
    expect(fitted.items.length).toBeLessThan(lines.length)
    expect(estimateOutputTokens(fitted.items.join('\n'))).toBeLessThanOrEqual(
      estimateOutputTokens(lines.join('\n')),
    )
  })

  it('validates the optional budget range', () => {
    expect(parseOutputTokenBudget(undefined, 'workspace.read')).toBe(undefined)
    expect(parseOutputTokenBudget(100, 'workspace.read')).toBe(100)
    expect(() => parseOutputTokenBudget(0, 'workspace.read')).toThrow('maxTokens')
    expect(() => parseOutputTokenBudget(100001, 'workspace.read')).toThrow('maxTokens')
    expect(() => parseOutputTokenBudget('many', 'workspace.read')).toThrow('maxTokens')
  })
})
