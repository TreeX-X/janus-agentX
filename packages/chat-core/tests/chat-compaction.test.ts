/**
 * LLM compaction loop: head selection, single-summary invariant,
 * iterative updates, validation retry, and failure fallback.
 * Pure core with stub summarizers (no network, no transport).
 */
import { describe, expect, it } from 'vitest'
import {
  ChatSessionRuntime,
  buildCompactionPrompt,
  isContextOverflowError,
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

  it('reserves summary budget so the compacted view never exceeds the window', async () => {
    const runtime = new ChatSessionRuntime()
    const model = { contextWindow: 1200, maxOutputTokens: 100 }
    const budget = 1200 - 100 - 512
    const messages = [
      user(`old ${'a'.repeat(2600)}`),
      user(`mid ${'b'.repeat(2200)}`),
      user('now'),
    ] as JanusAgentMessage[]
    let calls = 0
    const summarize = async () => { calls += 1; return VALID_SUMMARY }
    expect(await runtime.maybeCompact(messages, { model }, summarize, new AbortController().signal)).toBe(true)
    // Reserving the first summary evicts `mid` too; the loop converges in a second pass.
    expect(calls).toBe(2)
    const context = runtime.buildContext(messages, { model })
    const total = context.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0)
    expect(total).toBeLessThanOrEqual(budget)
    expect(context.at(-1)?.content).toBe('now')
    expect(context.some((message) => message.content.includes('## Goal'))).toBe(true)
    expect(context.some((message) => message.content.includes('b'.repeat(50)))).toBe(false)
  })

  it('round-trips persisted summary state without re-summarizing', async () => {    const runtime = new ChatSessionRuntime()
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

describe('lightweight hardening: ceiling, oversized survival, file ledger', () => {
  it('caps the trigger at 90% of the window so late tuning cannot overflow', () => {
    // Window 10k, maxOutput 100: uncapped budget would be 9388 tokens, but the
    // hard ceiling holds it at 9000. A 9200-token history fits the former and
    // exceeds the latter, so the old turn must drop.
    const model = { contextWindow: 10_000, maxOutputTokens: 100 }
    const messages = [
      user(`old ${'a'.repeat(19_997)}`),
      user(`now ${'b'.repeat(16_797)}`),
    ] as JanusAgentMessage[]
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext(messages, { model, bufferTokens: 0 })
    expect(context.some((m) => m.content.includes('a'.repeat(50)))).toBe(false)
    expect(context.at(-1)?.content).toContain('now')
    // An absurd buffer clamps to 10% (earlier trigger) instead of breaking:
    // the view still builds and still favors the newest turn.
    const clamped = new ChatSessionRuntime()
    const early = clamped.buildContext(messages, { model, bufferTokens: 999_999_999 })
    expect(early.at(-1)?.content).toContain('now')
  })

  it('returns an explicit omitted-body result for an oversized current tool batch', () => {
    const runtime = new ChatSessionRuntime()
    const huge = toolUnit('big', `dump ${'z'.repeat(8_000)}`)
    const context = runtime.buildContext(
      [{ role: 'system', content: 'policy' }, ...huge] as JanusAgentMessage[],
      { model: MODEL },
    )
    expect(context.map((m) => m.role)).toContain('system')
    const result = JSON.parse(context.find((m) => m.role === 'tool')!.content)
    expect(result.outputOmitted).toBe(true)
    expect(result.guidance).toContain('SAME start offset')
    expect(context.some((m) => m.toolCalls?.[0]?.id === 'big')).toBe(true)
  })

  it('force-summarizes an oversized single turn and appends exact file refs', async () => {
    const runtime = new ChatSessionRuntime()
    const messages = [
      user('fix login'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'workspace_read', arguments: { path: 'src/auth.ts' } }] },
      { role: 'tool', toolCallId: 'r1', toolName: 'workspace_read', content: `body ${'q'.repeat(5_000)}` },
      user('now'),
    ] as JanusAgentMessage[]
    const summarize = async () => VALID_SUMMARY
    expect(await runtime.maybeCompact(
      messages, { model: MODEL, force: true }, summarize, new AbortController().signal,
    )).toBe(true)
    const summary = runtime.getSummary() ?? ''
    expect(summary).toContain('## Goal')
    expect(summary).toContain('src/auth.ts')
    const info = runtime.getLastCompactionInfo()
    expect(info).not.toBeNull()
    expect(info!.tokensBefore).toBeGreaterThan(0)
    expect(info!.summaryChars).toBeGreaterThan(0)
  })

  it('renders manual focus into the summary prompt without dropping sections', () => {
    const { prompt } = buildCompactionPrompt(undefined, '[User]: hi', 'auth refactor and three failing tests')
    expect(prompt).toContain('auth refactor and three failing tests')
    expect(prompt).toContain('## Relevant Files')
  })

  it('recognizes provider overflow signals and nothing else', () => {
    expect(isContextOverflowError(new Error('context window exceeded'))).toBe(true)
    expect(isContextOverflowError(new Error('413 Request Entity Too Large'))).toBe(true)
    expect(isContextOverflowError(new Error('connection reset by peer'))).toBe(false)
    expect(isContextOverflowError('all good')).toBe(false)
  })
})
