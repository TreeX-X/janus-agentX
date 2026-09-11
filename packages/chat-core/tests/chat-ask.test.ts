/**
 * ask_user core: request validation, result formatting, history notes.
 */
import { describe, expect, it } from 'vitest'
import {
  askCancelledContent,
  formatAskHistoryNote,
  formatAskResultContent,
  formatAskSummary,
  validateAskUserRequest,
} from '../src/main/llm/chat-ask.js'

function validInput() {
  return {
    questions: [
      {
        question: 'Which API style?',
        header: 'API style',
        options: [
          { label: 'REST', description: 'simple' },
          { label: 'GraphQL', description: 'flexible' },
        ],
      },
      {
        question: 'Pick extras',
        header: 'Extras',
        options: [{ label: 'JWT' }, { label: 'mTLS' }],
        multiple: true,
      },
    ],
  }
}

describe('validateAskUserRequest', () => {
  it('accepts a valid request with allowCustom defaulting to true', () => {
    const result = validateAskUserRequest(validInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.request.allowCustom).toBe(true)
    expect(result.request.questions).toHaveLength(2)
    expect(result.request.questions[1]?.multiple).toBe(true)
  })

  it('rejects empty, oversized, and malformed question lists', () => {
    expect(validateAskUserRequest({ questions: [] }).ok).toBe(false)
    expect(validateAskUserRequest({}).ok).toBe(false)
    expect(validateAskUserRequest({
      questions: [1, 2, 3, 4, 5].map((n) => ({
        question: `Q${n}`, header: `H${n}`, options: [{ label: 'A' }, { label: 'B' }],
      })),
    }).ok).toBe(false)
  })

  it('rejects bad headers, option counts, duplicates, and budgets', () => {
    const one = validInput()
    one.questions[0]!.header = ''
    expect(validateAskUserRequest(one).ok).toBe(false)

    const two = validInput()
    two.questions[0]!.header = 'x'.repeat(31)
    expect(validateAskUserRequest(two).ok).toBe(false)

    const three = validInput()
    three.questions[0]!.options = [{ label: 'Only' }]
    expect(validateAskUserRequest(three).ok).toBe(false)

    const four = validInput()
    four.questions[0]!.options = [{ label: 'Same' }, { label: 'same' }]
    expect(validateAskUserRequest(four).ok).toBe(false)

    expect(validateAskUserRequest({ questions: validInput().questions, allowCustom: 'yes' }).ok).toBe(false)
  })
})

describe('ask formatting', () => {
  const answered = {
    status: 'answered' as const,
    answers: [
      { header: 'API style', selected: ['REST'] },
      { header: 'Extras', selected: ['JWT', 'mTLS'], custom: 'plus audit' },
    ],
  }

  it('serializes answers as bounded JSON for the model', () => {
    const content = formatAskResultContent(answered)
    expect(content).toContain('"REST"')
    expect(content).toContain('"custom":"plus audit"')
  })

  it('summarizes for cards and history notes, null on cancel', () => {
    expect(formatAskSummary(answered)).toBe('Q1→REST; Q2→JWT+mTLS')
    expect(formatAskSummary({ status: 'cancelled' })).toBe('question cancelled')
    expect(formatAskHistoryNote(answered)).toContain('API style → REST')
    expect(formatAskHistoryNote({ status: 'cancelled' })).toBeNull()
    expect(askCancelledContent()).toContain('cancelled by user')
  })
})
