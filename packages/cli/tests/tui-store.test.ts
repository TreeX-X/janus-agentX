/**
 * TUI reducer: full ChatAgentEvent coverage without Ink.
 */
import { describe, expect, it } from 'vitest'
import { createInitialState, reduceTuiState } from '../src/tui/store.js'
import type { ChatAgentEvent } from '@janus-agent/chat-core'

function reduceAll(events: ChatAgentEvent[]) {
  let state = createInitialState()
  state = reduceTuiState(state, { type: 'turn-start' })
  for (const event of events) state = reduceTuiState(state, { type: 'agent-event', event })
  return state
}

const RID = 'r1'

describe('reduceTuiState', () => {
  it('streams text deltas into pending text and commits on turn-done', () => {
    let state = reduceAll([
      { type: 'agent_start', requestId: RID },
      { type: 'text_delta', requestId: RID, delta: 'hel' },
      { type: 'text_delta', requestId: RID, delta: 'lo' },
    ])
    expect(state.status).toBe('thinking')
    expect(state.pendingText).toBe('hello')
    state = reduceTuiState(state, { type: 'turn-done', cancelled: false, assistantText: 'hello' })
    expect(state.pendingText).toBe('')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ role: 'assistant', text: 'hello' })
  })

  it('tracks tool cards through ready/running/end', () => {
    const state = reduceAll([
      { type: 'tool_call_ready', requestId: RID, callId: 'c1', toolName: 'workspace.create', argumentKeys: ['path'] },
      { type: 'tool_execution_start', requestId: RID, callId: 'c1', toolName: 'workspace.create' },
      { type: 'tool_execution_end', requestId: RID, callId: 'c1', toolName: 'workspace.create', status: 'completed' },
    ])
    expect(state.toolCards).toHaveLength(1)
    expect(state.toolCards[0]).toMatchObject({ toolName: 'workspace.create', status: 'completed', detail: 'path' })
  })

  it('marks failed cards and surfaces model errors', () => {
    const failed = reduceAll([
      { type: 'tool_execution_end', requestId: RID, callId: 'c9', toolName: 'workspace.edit', status: 'failed' },
    ])
    expect(failed.toolCards[0].status).toBe('failed')
    const errored = reduceTuiState(createInitialState(), {
      type: 'agent-event',
      event: { type: 'model_error', requestId: RID, code: 'E_MODEL', retryable: true },
    })
    expect(errored.status).toBe('error')
    expect(errored.statusText).toContain('E_MODEL')
  })

  it('keeps cancellation banners and clears on demand', () => {
    let state = reduceAll([{ type: 'stream_end', requestId: RID, cancelled: true }])
    expect(state.statusText).toContain('cancelled')
    state = reduceTuiState(state, { type: 'user-message', text: 'hi' })
    expect(state.messages).toHaveLength(1)
    state = reduceTuiState(state, { type: 'clear' })
    expect(state.messages).toHaveLength(0)
    expect(state.status).toBe('idle')
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
