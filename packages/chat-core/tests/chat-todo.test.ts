/**
 * chat-todo: validation, formatting, and sticky-bar helpers (no IO).
 */
import { describe, expect, it } from 'vitest'
import {
  cloneTodos,
  formatTodoStateMessage,
  hasOpenTodos,
  summarizeTodos,
  validateTodoList,
  TODO_MAX_ITEMS,
} from '../src/main/llm/chat-todo.js'

describe('validateTodoList', () => {
  it('accepts a well-formed list with one in_progress', () => {
    const result = validateTodoList([
      { content: 'Explore', status: 'completed' },
      { content: 'Implement', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ])
    expect(result.ok).toBe(true)
  })

  it('rejects empty lists so the sticky bar never renders blank', () => {
    const result = validateTodoList([])
    expect(result.ok).toBe(false)
  })

  it('rejects dual in_progress so the model self-heals', () => {
    const result = validateTodoList([
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'in_progress' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/one todo/i)
  })

  it('rejects oversized lists and overlong content', () => {
    const tooMany = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({ content: `t${i}`, status: 'pending' }))
    expect(validateTodoList(tooMany).ok).toBe(false)
    expect(validateTodoList([{ content: 'x'.repeat(201), status: 'pending' }]).ok).toBe(false)
    expect(validateTodoList([{ content: 'ok', status: 'bogus' }]).ok).toBe(false)
  })
})

describe('sticky helpers', () => {
  const todos = [
    { content: 'A', status: 'completed' as const },
    { content: 'B', status: 'in_progress' as const },
    { content: 'C', status: 'pending' as const },
  ]

  it('formats a bounded system snapshot (null when empty)', () => {
    expect(formatTodoStateMessage([])).toBeNull()
    const message = formatTodoStateMessage(todos)
    expect(message).toContain('[in_progress] B')
  })

  it('summarizes n/m plus the current item', () => {
    expect(summarizeTodos(todos)).toMatchObject({ total: 3, done: 1, open: 2, current: 'B' })
  })

  it('hides the bar when empty or fully done', () => {
    expect(hasOpenTodos([])).toBe(false)
    expect(hasOpenTodos([{ content: 'A', status: 'completed' }])).toBe(false)
    expect(hasOpenTodos(todos)).toBe(true)
  })

  it('clones across IPC boundaries', () => {
    const cloned = cloneTodos(todos)
    expect(cloned).toEqual(todos)
    expect(cloned).not.toBe(todos)
  })
})
