/**
 * TUI reducer: timeline ordering (thinking/tool/text interleave) without Ink.
 */
import { describe, expect, it } from 'vitest'
import { buildFooterText, createInitialState, formatTokenCount, formatTokenUsage, reduceTuiState } from '../src/tui/store.js'
import type { ChatAgentEvent } from '@janus-agent/chat-core'

function reduceAll(events: ChatAgentEvent[]) {
  let state = createInitialState()
  state = reduceTuiState(state, { type: 'turn-start' })
  for (const event of events) state = reduceTuiState(state, { type: 'agent-event', event })
  return state
}

const RID = 'r1'

function kinds(state: ReturnType<typeof reduceAll>): string[] {
  return state.blocks.map((block) => block.kind)
}

describe('reduceTuiState timeline', () => {
  it('scopes reused tool call IDs to the current turn', () => {
    let state = reduceAll([{ type: 'tool_execution_end', requestId: RID, callId: 'c', toolName: 'old_tool', status: 'completed' }])
    state = reduceTuiState(state, { type: 'user-message', text: 'next' })
    state = reduceTuiState(state, { type: 'agent-event', event: { type: 'tool_call_ready', requestId: 'r2', callId: 'c', toolName: 'new_tool', argumentKeys: [] } })
    state = reduceTuiState(state, { type: 'tool-display', callId: 'c', display: { category: 'tool', target: 'new target' } })
    expect(state.blocks[0]).toMatchObject({ toolName: 'old_tool', toolStatus: 'completed' })
    expect(state.blocks[0].display).toBeUndefined()
    expect(state.blocks[2]).toMatchObject({ toolName: 'new_tool', display: { target: 'new target' } })
  })

  it('keeps the turn active between model finish and tool execution, and finalizes cancelled cards', () => {
    let state = reduceAll([
      { type: 'reasoning_delta', requestId: RID, delta: 'Inspect first' },
      { type: 'tool_call_start', requestId: RID, callId: 'c1', toolName: 'workspace_read' },
      { type: 'tool_call_delta', requestId: RID, callId: 'c1', argumentDeltaLength: 10 },
      { type: 'model_finish', requestId: RID, reason: 'tool_calls' },
    ])
    expect(state.status).toBe('thinking')
    expect(state.activeBlockId).toBeUndefined()
    expect(state.blocks[0].endedAt).toBeDefined()
    expect(state.blocks[1]).toMatchObject({ toolStatus: 'preparing', argumentChars: 10 })
    state = reduceTuiState(state, { type: 'turn-done', cancelled: true, assistantText: '' })
    expect(state.status).toBe('idle')
    expect(state.blocks[1].toolStatus).toBe('cancelled')
  })

  it('enriches finished tools immediately, aggregates usage and keeps old traces out of a new turn', () => {
    let state = reduceAll([{ type: 'tool_execution_end', requestId: RID, callId: 'old', toolName: 'workspace_read', status: 'completed' }])
    state = reduceTuiState(state, { type: 'user-message', text: 'new turn' })
    state = reduceTuiState(state, { type: 'turn-start' })
    state = reduceTuiState(state, { type: 'agent-event', event: { type: 'tool_execution_end', requestId: 'r2', callId: 'new', toolName: 'workspace_read', status: 'completed' } })
    state = reduceTuiState(state, { type: 'tool-display', callId: 'new', display: { category: 'read', target: 'path: a.ts', output: ['file body'], durationMs: 12 } })
    state = reduceTuiState(state, { type: 'turn-traces', traces: [{ toolName: 'workspace.read', summary: 'new result', diff: [] }] })
    state = reduceTuiState(state, { type: 'usage', promptTokens: 10, completionTokens: 5 })
    state = reduceTuiState(state, { type: 'usage', promptTokens: 20, completionTokens: 3 })
    expect(state.promptTokens).toBe(30)
    expect(state.completionTokens).toBe(8)
    expect(state.blocks[0].toolSummary).toBeUndefined()
    expect(state.blocks[2]).toMatchObject({ toolSummary: 'new result', display: { output: ['file body'] } })
  })

  it('streams text deltas into one assistant block and never duplicates on turn-done', () => {
    let state = reduceAll([
      { type: 'agent_start', requestId: RID },
      { type: 'text_delta', requestId: RID, delta: 'hel' },
      { type: 'text_delta', requestId: RID, delta: 'lo' },
    ])
    expect(state.status).toBe('thinking')
    expect(kinds(state)).toEqual(['assistant'])
    expect(state.blocks[0].text).toBe('hello')
    state = reduceTuiState(state, { type: 'turn-done', cancelled: false, assistantText: 'hello' })
    expect(kinds(state)).toEqual(['assistant'])
    expect(state.blocks).toHaveLength(1)
  })

  it('interleaves thinking, tools, and text in stream order with full reasoning text', () => {
    const state = reduceAll([
      { type: 'reasoning_delta', requestId: RID, delta: 'let me check ' },
      { type: 'reasoning_delta', requestId: RID, delta: 'the file' },
      { type: 'text_delta', requestId: RID, delta: 'looking…' },
      { type: 'tool_call_ready', requestId: RID, callId: 'c1', toolName: 'workspace.read', argumentKeys: ['path'] },
      { type: 'tool_execution_start', requestId: RID, callId: 'c1', toolName: 'workspace.read' },
      { type: 'reasoning_delta', requestId: RID, delta: 'got it' },
      { type: 'tool_execution_end', requestId: RID, callId: 'c1', toolName: 'workspace.read', status: 'completed' },
      { type: 'text_delta', requestId: RID, delta: 'found it' },
    ])
    expect(kinds(state)).toEqual(['thinking', 'assistant', 'tool', 'thinking', 'assistant'])
    expect(state.blocks[0].text).toBe('let me check the file')
    expect(state.blocks[2]).toMatchObject({ toolName: 'workspace.read', toolStatus: 'completed', toolDetail: 'path' })
    expect(state.blocks[3].text).toBe('got it')
    expect(state.blocks[4].text).toBe('found it')
  })

  it('marks failed cards and surfaces model errors', () => {
    const failed = reduceAll([
      { type: 'tool_execution_end', requestId: RID, callId: 'c9', toolName: 'workspace.edit', status: 'failed' },
    ])
    const tool = failed.blocks.find((block) => block.kind === 'tool')
    expect(tool?.toolStatus).toBe('failed')
    const errored = reduceTuiState(createInitialState(), {
      type: 'agent-event',
      event: { type: 'model_error', requestId: RID, code: 'E_MODEL', retryable: true },
    })
    expect(errored.status).toBe('error')
    expect(errored.statusText).toContain('E_MODEL')
  })

  it('backfills the final text when the stream carried none', () => {
    const state = reduceTuiState(createInitialState(), { type: 'turn-done', cancelled: false, assistantText: 'late text' })
    expect(kinds(state)).toEqual(['assistant'])
    expect(state.blocks[0].text).toBe('late text')
  })

  it('toggles thinking expansion without touching the timeline', () => {
    let state = reduceAll([{ type: 'reasoning_delta', requestId: RID, delta: 'hmm' }])
    expect(state.thinkingExpanded).toBe(false)
    state = reduceTuiState(state, { type: 'toggle-thinking' })
    expect(state.thinkingExpanded).toBe(true)
    expect(kinds(state)).toEqual(['thinking'])
    state = reduceTuiState(state, { type: 'toggle-thinking' })
    expect(state.thinkingExpanded).toBe(false)
  })

  it('keeps cancellation banners and clears on demand', () => {
    let state = reduceAll([{ type: 'stream_end', requestId: RID, cancelled: true }])
    expect(state.statusText).toContain('cancelled')
    state = reduceTuiState(state, { type: 'user-message', text: 'hi' })
    expect(kinds(state)).toEqual(['user'])
    state = reduceTuiState(state, { type: 'clear' })
    expect(state.blocks).toHaveLength(0)
    expect(state.status).toBe('idle')
  })

  it('hydrates history into blocks and preserves the thinking toggle', () => {
    let state = reduceAll([{ type: 'reasoning_delta', requestId: RID, delta: 'hmm' }])
    state = reduceTuiState(state, { type: 'toggle-thinking' })
    state = reduceTuiState(state, {
      type: 'hydrate',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello' },
      ],
    })
    expect(kinds(state)).toEqual(['user', 'assistant'])
    expect(state.thinkingExpanded).toBe(true)
  })

  it('caps tool blocks by dropping the oldest finished ones', () => {
    const events: ChatAgentEvent[] = []
    for (let i = 0; i < 35; i += 1) {
      events.push({ type: 'tool_execution_end', requestId: RID, callId: `c${i}`, toolName: 't', status: 'completed' })
    }
    const state = reduceAll(events)
    const tools = state.blocks.filter((block) => block.kind === 'tool')
    expect(tools).toHaveLength(30)
    expect(tools[0].callId).toBe('c5')
  })

  it('attaches trace previews to tool blocks across naming styles', () => {
    let state = reduceAll([
      { type: 'tool_call_ready', requestId: RID, callId: 'c1', toolName: 'workspace_edit', argumentKeys: ['path'] },
      { type: 'tool_call_ready', requestId: RID, callId: 'c2', toolName: 'workspace_read', argumentKeys: ['path'] },
    ])
    state = reduceTuiState(state, {
      type: 'turn-traces',
      traces: [
        // Runtime dotted names pair with model underscore names nth-with-nth.
        { toolName: 'workspace.edit', summary: 'Edit a.ts (2 replacements)', diff: ['-old', '+new'] },
        { toolName: 'workspace.read', summary: 'a.ts, sha256=ab12', diff: [] },
      ],
    })
    const tools = state.blocks.filter((block) => block.kind === 'tool')
    expect(tools[0]).toMatchObject({ toolSummary: 'Edit a.ts (2 replacements)', toolPreview: ['-old', '+new'] })
    expect(tools[1]).toMatchObject({ toolSummary: 'a.ts, sha256=ab12', toolPreview: [] })
  })

  it('accumulates session token totals across turns while per-turn counters reset', () => {
    let state = createInitialState()
    state = reduceTuiState(state, { type: 'turn-start' })
    state = reduceTuiState(state, { type: 'usage', promptTokens: 10, completionTokens: 5 })
    expect(state.promptTokens).toBe(10)
    expect(state.sessionPromptTokens).toBe(10)
    expect(state.sessionCompletionTokens).toBe(5)
    state = reduceTuiState(state, { type: 'turn-done', cancelled: false, assistantText: 'done' })
    state = reduceTuiState(state, { type: 'turn-start' })
    expect(state.promptTokens).toBe(0)
    expect(state.completionTokens).toBe(0)
    expect(state.sessionPromptTokens).toBe(10)
    state = reduceTuiState(state, { type: 'usage', promptTokens: 20, completionTokens: 3 })
    expect(state.promptTokens).toBe(20)
    expect(state.sessionPromptTokens).toBe(30)
    expect(state.sessionCompletionTokens).toBe(8)
    state = reduceTuiState(state, { type: 'clear' })
    expect(state.sessionPromptTokens).toBe(0)
    expect(state.sessionCompletionTokens).toBe(0)
  })

  it('formats token counts compactly and builds the split-bar meta', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(12)).toBe('12')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(12345)).toBe('12.3k')
    expect(formatTokenCount(1500000)).toBe('1.5M')
    expect(formatTokenUsage(12, 8)).toBe('12 in / 8 out')
    // Right-side meta only: key hints live on the left side of the split
    // bar, so an empty state renders nothing here.
    expect(buildFooterText({})).toBe('')
    const bare = buildFooterText({ conversationLabel: 'conv', statusText: 'done' })
    expect(bare).toBe('conv · done')
    expect(bare).not.toContain('wheel')
    // Tokens follow state, scroll badge is ↑N only.
    const full = buildFooterText({
      statusText: 'done',
      sessionPromptTokens: 12345,
      sessionCompletionTokens: 678,
      hiddenRows: 7,
    })
    expect(full).toBe('done · 12.3k in / 678 out · ↑7')
    expect(full).not.toContain('wheel')
    expect(full).not.toContain('PgDn')
  })

  it('holds approval prompts until resolved', () => {
    let state = createInitialState()
    state = reduceTuiState(state, {
      type: 'approval-requested',
      approval: { toolName: 'workspace.create', workspaceId: 'cli', actionRisk: 'create' },
    })
    expect(state.awaitingApproval?.toolName).toBe('workspace.create')
    state = reduceTuiState(state, { type: 'approval-resolved' })
    expect(state.awaitingApproval).toBeNull()
  })
})
