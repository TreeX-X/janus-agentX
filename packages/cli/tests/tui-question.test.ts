/**
 * ask_user UI contracts (no Ink): plain picker parsing, the injected-line
 * question flow, reducer gates, and compact question tool cards.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arrayLineSource, runRepl } from '../src/repl.js'
import { memoryConversationStore } from '../src/conversations.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import {
  normalizeCustomAnswer,
  parseQuestionPickerInput,
  questionPickerRows,
  questionPromptHead,
} from '../src/tui/question-state.js'
import { arrayLineSource, askQuestionPlain } from '../src/repl.js'
import { createInitialState, reduceTuiState } from '../src/tui/store.js'
import { toDisplayEvent } from '../src/tool-display.js'

const QUESTION = {
  question: 'Which API style?',
  header: 'API style',
  options: [
    { label: 'REST', description: 'simple' },
    { label: 'GraphQL', description: 'flexible' },
  ],
  multiple: false,
}

const MULTI = {
  ...QUESTION,
  header: 'Extras',
  options: [{ label: 'JWT' }, { label: 'mTLS' }, { label: 'Oauth' }],
  multiple: true,
}

const PROMPT = { questions: [QUESTION], allowCustom: true, callId: 'c1' } as never
const NEVER_ABORT = new AbortController().signal

function collect() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (text: string) => { out.push(text) },
    stderr: (text: string) => { err.push(text) },
  }
}

describe('parseQuestionPickerInput', () => {
  it('accepts numbers and exact labels (case-insensitive)', () => {
    expect(parseQuestionPickerInput('1', QUESTION, true)).toEqual({ action: 'answer', selected: ['REST'] })
    expect(parseQuestionPickerInput('graphql', QUESTION, true)).toEqual({ action: 'answer', selected: ['GraphQL'] })
    expect(parseQuestionPickerInput('', QUESTION, true)).toEqual({ action: 'empty' })
  })

  it('parses multi-select lists and dedupes', () => {
    expect(parseQuestionPickerInput('1,3', MULTI, false)).toEqual({ action: 'answer', selected: ['JWT', 'Oauth'] })
    expect(parseQuestionPickerInput('jwt, JWT', MULTI, false)).toEqual({ action: 'answer', selected: ['JWT'] })
    // Single-choice rejects lists.
    expect(parseQuestionPickerInput('1,2', QUESTION, true).action).toBe('error')
  })

  it('routes custom/cancel tokens', () => {
    expect(parseQuestionPickerInput('c', QUESTION, true)).toEqual({ action: 'custom' })
    expect(parseQuestionPickerInput('c', QUESTION, false).action).toBe('error')
    expect(parseQuestionPickerInput('q', QUESTION, true)).toEqual({ action: 'cancel' })
    expect(parseQuestionPickerInput('nope', QUESTION, true).action).toBe('error')
  })

  it('bounds custom answers', () => {
    expect(normalizeCustomAnswer('  ').ok).toBe(false)
    expect(normalizeCustomAnswer('use REST').ok).toBe(true)
    expect(questionPickerRows(QUESTION)).toHaveLength(2)
    expect(questionPromptHead(0, 2, 'API style')).toContain('1/2')
  })
})

describe('askQuestionPlain', () => {
  it('answers one question by number', async () => {
    const c = collect()
    const answer = await askQuestionPlain(arrayLineSource(['1']), c.stdout, c.stderr, PROMPT, NEVER_ABORT)
    expect(answer).toEqual({ status: 'answered', answers: [{ header: 'API style', selected: ['REST'] }] })
    expect(c.out.join('')).toContain('ask_user 1/1')
  })

  it('takes a custom answer via c', async () => {
    const c = collect()
    const answer = await askQuestionPlain(arrayLineSource(['c', 'use tRPC internally']), c.stdout, c.stderr, PROMPT, NEVER_ABORT)
    expect(answer).toEqual({
      status: 'answered',
      answers: [{ header: 'API style', selected: [], custom: 'use tRPC internally' }],
    })
  })

  it('cancels the whole call on q, EOF, empty custom, and retry exhaustion', async () => {
    const c = collect()
    expect(await askQuestionPlain(arrayLineSource(['q']), c.stdout, c.stderr, PROMPT, NEVER_ABORT)).toEqual({ status: 'cancelled' })
    expect(await askQuestionPlain(arrayLineSource([null]), c.stdout, c.stderr, PROMPT, NEVER_ABORT)).toEqual({ status: 'cancelled' })
    expect(await askQuestionPlain(arrayLineSource(['c', '   ']), c.stdout, c.stderr, PROMPT, NEVER_ABORT)).toEqual({ status: 'cancelled' })
    expect(await askQuestionPlain(arrayLineSource(['x', 'y', 'z']), c.stdout, c.stderr, PROMPT, NEVER_ABORT)).toEqual({ status: 'cancelled' })
    expect(c.err.join('')).toContain('Unknown option')
  })

  it('walks multiple questions in order', async () => {
    const c = collect()
    const multi = { questions: [QUESTION, MULTI], allowCustom: false, callId: 'c2' } as never
    const answer = await askQuestionPlain(arrayLineSource(['2', '1,2']), c.stdout, c.stderr, multi, NEVER_ABORT)
    expect(answer).toEqual({
      status: 'answered',
      answers: [
        { header: 'API style', selected: ['GraphQL'] },
        { header: 'Extras', selected: ['JWT', 'mTLS'] },
      ],
    })
  })

  it('cancels on an aborted signal without consuming input', async () => {
    const c = collect()
    const controller = new AbortController()
    controller.abort()
    expect(await askQuestionPlain(arrayLineSource(['1']), c.stdout, c.stderr, PROMPT, controller.signal)).toEqual({ status: 'cancelled' })
  })
})

describe('question TUI state', () => {
  it('opens the gate on question_requested and closes on resolved', () => {
    let state = createInitialState()
    expect(state.awaitingQuestion).toBeNull()
    state = reduceTuiState(state, {
      type: 'agent-event',
      event: {
        type: 'question_requested',
        requestId: 'r',
        callId: 'c1',
        questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A' }, { label: 'B' }], multiple: false }],
        allowCustom: true,
      },
    })
    expect(state.awaitingQuestion?.questions).toHaveLength(1)
    expect(state.statusText).toContain('pick')
    state = reduceTuiState(state, {
      type: 'agent-event',
      event: { type: 'question_resolved', requestId: 'r', callId: 'c1', status: 'answered' },
    })
    expect(state.awaitingQuestion).toBeNull()
  })

  it('supports direct dispatch and clears on hydrate/clear', () => {
    let state = reduceTuiState(createInitialState(), {
      type: 'question-requested',
      question: { callId: 'c1', questions: [], allowCustom: true },
    })
    expect(state.awaitingQuestion?.callId).toBe('c1')
    state = reduceTuiState(state, { type: 'question-resolved' })
    expect(state.awaitingQuestion).toBeNull()
    state = reduceTuiState(state, {
      type: 'question-requested',
      question: { callId: 'c2', questions: [], allowCustom: false },
    })
    state = reduceTuiState(state, { type: 'hydrate', messages: [] })
    expect(state.awaitingQuestion).toBeNull()
    state = reduceTuiState(state, {
      type: 'question-requested',
      question: { callId: 'c3', questions: [], allowCustom: false },
    })
    state = reduceTuiState(state, { type: 'clear' })
    expect(state.awaitingQuestion).toBeNull()
  })
})

describe('ask_user mid-turn flow in the plain loop', () => {
  it('asks mid-turn, consumes the injected answer, and finishes the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-ask-e2e-'))
    const out: string[] = []
    const err: string[] = []
    let n = 0
    const streamTextFn = (async () => {
      n += 1
      if (n === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: 'tool-call',
              toolCallId: 'q1',
              toolName: 'ask_user',
              args: {
                questions: [{
                  question: 'Which API style?',
                  header: 'API style',
                  options: [{ label: 'REST' }, { label: 'GraphQL' }],
                }],
              },
            }
            yield { type: 'finish', finishReason: 'tool-calls' }
          })(),
          textStream: (async function* () { })(),
        }
      }
      return { textStream: (async function* () { yield 'building REST' })() }
    }) as ChatTurnPorts['streamTextFn']
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        stdout: (text: string) => { out.push(text) },
        stderr: (text: string) => { err.push(text) },
        env: {} as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        authPath: null,
        lines: arrayLineSource(['build the api', '1', '/exit']),
        streamTextFn,
      },
    )
    const all = out.join('')
    expect(code).toBe(0)
    expect(all).toContain('ask_user')
    expect(all).toContain('API style → REST')
    expect(all).toContain('building REST')
    expect(err.join('')).not.toContain('chat turn failed')
  })
})

describe('ask_user tool cards', () => {
  it('keeps the timeline card to one summary line', () => {
    const ready = toDisplayEvent({
      type: 'tool_call_ready',
      call: { id: 'c1', name: 'ask_user', arguments: {} },
    } as never)
    expect(ready).toMatchObject({ type: 'tool-display', callId: 'c1', display: { target: 'question' } })
    const done = toDisplayEvent({
      type: 'tool_execution_end',
      call: { id: 'c1', name: 'ask_user', arguments: {} },
      result: { content: JSON.stringify({ answers: [{ header: 'API style', selected: ['REST'] }] }) },
      isError: false,
    } as never)
    expect(done).toMatchObject({
      type: 'tool-display',
      display: { category: 'tool', target: 'question', summary: 'Q1→REST' },
    })
    const cancelled = toDisplayEvent({
      type: 'tool_execution_end',
      call: { id: 'c1', name: 'ask_user', arguments: {} },
      result: { content: 'Question cancelled by user (no answers recorded).' },
      isError: true,
    } as never)
    expect(cancelled).toMatchObject({
      type: 'tool-display',
      display: { summary: expect.stringContaining('cancelled') },
    })
  })
})
