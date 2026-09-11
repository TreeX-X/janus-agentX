/**
 * Todo sticky bar: reducer mirror + compact todo_write tool cards (no Ink).
 */
import { describe, expect, it } from 'vitest'
import { createInitialState, reduceTuiState } from '../src/tui/store.js'
import { toDisplayEvent } from '../src/tool-display.js'

const RID = 'r-todo'

describe('todo sticky state', () => {
  it('mirrors todo_update wholesale and hides nothing in the store', () => {
    let state = createInitialState()
    expect(state.todos).toEqual([])
    state = reduceTuiState(state, {
      type: 'agent-event',
      event: { type: 'todo_update', requestId: RID, todos: [{ content: 'A', status: 'in_progress' }] },
    })
    expect(state.todos).toEqual([{ content: 'A', status: 'in_progress' }])
    // Wholesale replace, not append.
    state = reduceTuiState(state, {
      type: 'agent-event',
      event: { type: 'todo_update', requestId: RID, todos: [{ content: 'A', status: 'completed' }] },
    })
    expect(state.todos).toEqual([{ content: 'A', status: 'completed' }])
  })

  it('toggles the collapsible box without touching the todo mirror', () => {
    let state = reduceTuiState(createInitialState(), {
      type: 'agent-event',
      event: { type: 'todo_update', requestId: RID, todos: [{ content: 'A', status: 'in_progress' }] },
    })
    expect(state.todosExpanded).toBe(false)
    state = reduceTuiState(state, { type: 'toggle-todos' })
    expect(state.todosExpanded).toBe(true)
    expect(state.todos).toEqual([{ content: 'A', status: 'in_progress' }])
    state = reduceTuiState(state, { type: 'toggle-todos' })
    expect(state.todosExpanded).toBe(false)
  })

  it('clears the bar on clear and restores it on hydrate (switch/resume)', () => {
    let state = reduceTuiState(createInitialState(), {
      type: 'agent-event',
      event: { type: 'todo_update', requestId: RID, todos: [{ content: 'A', status: 'pending' }] },
    })
    state = reduceTuiState(state, { type: 'clear' })
    expect(state.todos).toEqual([])
    state = reduceTuiState(state, {
      type: 'hydrate',
      messages: [{ role: 'user', text: 'hi' }],
      todos: [{ content: 'B', status: 'in_progress' }],
    })
    expect(state.todos).toEqual([{ content: 'B', status: 'in_progress' }])
    // Legacy hydrate without todos resets to empty (no cross-talk).
    state = reduceTuiState(state, { type: 'hydrate', messages: [] })
    expect(state.todos).toEqual([])
  })
})

describe('todo_write tool cards', () => {
  it('keeps the timeline card to one summary line', () => {
    const ready = toDisplayEvent({
      type: 'tool_call_ready',
      call: { id: 'c1', name: 'todo_write', arguments: { todos: [] } },
    } as never)
    expect(ready).toMatchObject({ type: 'tool-display', callId: 'c1' })
    const done = toDisplayEvent({
      type: 'tool_execution_end',
      call: { id: 'c1', name: 'todo_write', arguments: {} },
      result: { content: JSON.stringify([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]) },
      isError: false,
    } as never)
    expect(done).toMatchObject({
      type: 'tool-display',
      display: { category: 'tool', target: 'todo list', summary: expect.stringContaining('todo 1/2') },
    })
  })
})
