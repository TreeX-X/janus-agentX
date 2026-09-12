/**
 * LLM compaction loop: head selection, single-summary invariant,
 * iterative updates, validation retry, and failure fallback.
 * Pure core with stub summarizers (no network, no transport).
 */
import { describe, expect, it } from 'vitest'
import {
  ChatSessionRuntime,
  buildCompactionPrompt,
  isValidCompactionSummary,
  serializeConversationUnits,
} from '../src/main/llm/chat-session-runtime'
import type { JanusAgentMessage } from '@janus-agent/agent-core'

const MODEL = { contextWindow: 800, maxOutputTokens: 100 }
const VALID_SUMMARY = [
  '## Goal', 'Do X',
  '## Constraints & Preferences', '(none)',
  '## Progress', '### Done', '- [x] a', '### In Progress', '- [ ] b', '### Blocked', '(none)',
  '## Key Decisions', '(none)',
  '## Next Steps', '1. do Y',
  '## Critical Context', '(none)',
  '## Relevant Files', '(none)',
].join('\n')

function user(content: string): JanusAgentMessage {
  return { role: 'user', content }
}

function toolUnit(id: string, output: string): JanusAgentMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'workspace_read', arguments: { path: 'a.ts' } }] },
    { role: 'tool', toolCallId: id, toolName: 'workspace_read', content: output },
  ]
}

describe('compaction prompt builders', () => {
  it('validates required headings and serializes tool pairs glued', () => {
    expect(isValidCompactionSummary(VALID_SUMMARY)).toBe(true)
    expect(isValidCompactionSummary('a fine paragraph')).toBe(false)
    const text = serializeConversationUnits([[user('hi')], toolUnit('c1', 'out')])
    expect(text).toContain('[User]: hi')
    expect(text).toContain('[Assistant tool call]: workspace_read(')
    expect(text).toContain('[Tool result]: out')
    const { system, prompt } = buildCompactionPrompt(undefined, text)
    expect(system).toContain('notes-to-self')
    expect(prompt).toContain('## Relevant Files')
    const updated = buildCompactionPrompt('OLD MARKER', text)
    expect(updated.prompt).toContain('OLD MARKER')
  })
})

describe('ChatSessionRuntime.maybeCompact', () => {
  it('summarizes budget-dropped turns and injects one summary, then skips repeats', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [
      { role: 'system', content: 'policy' },
      user(`old request ${'x'.repeat(800)}`),
      user(`current request ${'y'.repeat(40)}`),
    ] as JanusAgentMessage[]
    let calls = 0
    const summarize = async () => { calls += 1; return VALID_SUMMARY }
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(true)
    expect(calls).toBe(1)
    expect(runtime.getSummary()).toBe(VALID_SUMMARY)
    // Same content compacts to the same head key: no second model call.
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(false)
    expect(calls).toBe(1)

    const context = runtime.buildContext(messages, { model: MODEL })
    expect(context.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(context[1].content).toContain('[Compacted context')
    expect(context[1].content).toContain('## Goal')
    expect(context.at(-1)?.content).toContain('current request')
    expect(context.some((message) => message.content.includes('old request'))).toBe(false)
  })

  it('updates iteratively: the next summary absorbs the previous one', async () => {
    const runtime = new ChatSessionRuntime()
    const prompts: string[] = []
    const summarize = async (input: { prompt: string }) => {
      prompts.push(input.prompt)
      return VALID_SUMMARY.replace('Do X', `Do X ${prompts.length}`)
    }
    const first = [user(`first ${'a'.repeat(800)}`), user('now')] as JanusAgentMessage[]
    expect(await runtime.maybeCompact(first, { model: MODEL }, summarize, new AbortController().signal)).toBe(true)
    const second = [user(`first ${'a'.repeat(800)}`), user(`middle ${'b'.repeat(800)}`), user('now')] as JanusAgentMessage[]
    expect(await runtime.maybeCompact(second, { model: MODEL }, summarize, new AbortController().signal)).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Do X 1')
  })

  it('force mode compacts short histories that fit the budget', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [user('one'), user('two')] as JanusAgentMessage[]
    let calls = 0
    const summarize = async () => { calls += 1; return VALID_SUMMARY }
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(false)
    expect(calls).toBe(0)
    expect(await runtime.maybeCompact(messages, { model: MODEL, force: true }, summarize, new AbortController().signal)).toBe(true)
    expect(calls).toBe(1)
    expect(await runtime.maybeCompact(
      [user('only')], { model: MODEL, force: true }, summarize, new AbortController().signal,
    )).toBe(false)
  })

  it('keeps tool calls glued to their results and system text out of the head', async () => {
    const runtime = new ChatSessionRuntime()
    const prompts: string[] = []
    const summarize = async (input: { prompt: string }) => { prompts.push(input.prompt); return VALID_SUMMARY }
    const messages = [
      { role: 'system', content: 'SECRET-POLICY-MARKER' },
      user('read it'),
      ...toolUnit('c9', 'file-bytes'),
      user('next'),
    ] as JanusAgentMessage[]
    expect(await runtime.maybeCompact(messages, { model: MODEL, force: true }, summarize, new AbortController().signal)).toBe(true)
    expect(prompts[0]).toContain('workspace_read')
    expect(prompts[0]).toContain('file-bytes')
    expect(prompts[0]).not.toContain('SECRET-POLICY-MARKER')
  })

  it('retries once on invalid summaries, then keeps deterministic behavior', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [user(`old ${'x'.repeat(800)}`), user('now')] as JanusAgentMessage[]
    let calls = 0
    const summarize = async () => { calls += 1; return 'junk without headings' }
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(false)
    expect(calls).toBe(2)
    expect(runtime.getSummary()).toBeNull()
    // History still prunes deterministically with exact digests.
    const context = runtime.buildContext(messages, { model: MODEL })
    expect(context.at(-1)?.content).toContain('now')
  })

  it('never throws when the summarizer fails', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [user(`old ${'x'.repeat(800)}`), user('now')] as JanusAgentMessage[]
    const summarize = async (): Promise<string> => { throw new Error('provider down') }
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(false)
    expect(runtime.getSummary()).toBeNull()
  })

  it('round-trips persisted summary state without re-summarizing', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [user(`old ${'x'.repeat(800)}`), user('now')] as JanusAgentMessage[]
    let calls = 0
    const summarize = async () => { calls += 1; return VALID_SUMMARY }
    expect(await runtime.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(true)
    const state = runtime.getCompactionState()
    expect(state).not.toBeNull()

    const resumed = new ChatSessionRuntime()
    resumed.setCompactionState(state!.summary, state!.key)
    expect(await resumed.maybeCompact(messages, { model: MODEL }, summarize, new AbortController().signal)).toBe(false)
    expect(calls).toBe(1)
    expect(resumed.buildContext(messages, { model: MODEL })[0].content).toContain('## Goal')
  })
})
