import { describe, expect, it } from 'vitest'
import {
  estimateOutputTokens,
  fitItemsToBudget,
  MODEL_TEXT_MAX_BYTES,
  MODEL_TEXT_MAX_LINES,
  parseOutputTokenBudget,
  truncateModelText,
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

  it('passes short model text through untouched', () => {
    expect(truncateModelText('hello', 'narrow it')).toBe('hello')
  })

  it('caps model text head-first with a narrower-query hint', () => {
    const text = Array.from({ length: MODEL_TEXT_MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n')
    const out = truncateModelText(text, 'Re-search narrower.')
    expect(out).toContain('Output truncated')
    expect(out).toContain('Re-search narrower.')
    expect(out.split('\n').length).toBeLessThan(MODEL_TEXT_MAX_LINES + 10)
    expect(out).toContain('line 0')
  })

  it('caps model text by bytes for long single lines', () => {
    const text = `short\n${'x'.repeat(MODEL_TEXT_MAX_BYTES + 100)}`
    const out = truncateModelText(text, 'Read a smaller range.')
    expect(out).toContain('Output truncated')
    expect(out).toContain('short')
  })
})
