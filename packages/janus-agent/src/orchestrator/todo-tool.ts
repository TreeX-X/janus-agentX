/**
 * @file Local `todo_write` tool (opencode `todowrite` parity).
 * @description Workspace-independent, approval-free planning tool. The model
 * replaces the whole list on every call; validation failures return
 * `isError` content so the model self-heals. Every success emits a
 * `todo_update` ChatAgentEvent for the sticky bar above the composer.
 */
import { z } from 'zod'
import {
  TODO_MAX_CONTENT_CHARS,
  TODO_MAX_ITEMS,
  TODOWRITE_TOOL_DESCRIPTION,
  TODOWRITE_TOOL_NAME,
  cloneTodos,
  validateTodoList,
  type ChatTodoItem,
} from '@janus-agent/chat-core'
import type { JanusAgentTool } from '@janus-agent/agent-core'

const todoItemSchema = z.object({
  content: z.string().min(1).max(TODO_MAX_CONTENT_CHARS),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
})

export const todoWriteParameters = z.object({
  todos: z.array(todoItemSchema).min(1).max(TODO_MAX_ITEMS),
})

export { TODOWRITE_TOOL_NAME }

export interface TodoToolHooks {
  getTodos: () => ChatTodoItem[]
  onUpdate: (todos: ChatTodoItem[]) => void
}

/** Vercel-style definition for the model-facing `tools` map. */
export function createTodoVercelTool(hooks: TodoToolHooks) {
  return {
    description: TODOWRITE_TOOL_DESCRIPTION,
    parameters: todoWriteParameters,
    execute: async (input: { todos: ChatTodoItem[] }) => {
      const validated = validateTodoList(input.todos)
      if (!validated.ok) throw new Error(validated.error)
      const next = cloneTodos(validated.todos)
      hooks.onUpdate(next)
      return JSON.stringify(next, null, 2)
    },
  }
}

/**
 * Loop-executed tool: same contract, but returns `JanusAgentToolResult`
 * content instead of throwing, and never touches the runtime registry.
 */
export function createTodoLoopTool(hooks: TodoToolHooks): JanusAgentTool {
  return {
    name: TODOWRITE_TOOL_NAME,
    executionMode: 'sequential',
    execute: async (call, signal) => {
      if (signal.aborted) return { content: 'Tool execution cancelled', isError: true }
      const args = (call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : {}) as { todos?: unknown }
      // Zod first (shape), then semantic rules (single in_progress) so the
      // model gets a precise, correctable message either way.
      const parsed = todoWriteParameters.safeParse({ todos: args.todos })
      if (!parsed.success) {
        return { content: `Invalid todo_write arguments: ${parsed.error.issues[0]?.message ?? 'expected {todos: [{content, status}]}'}. Pass the full updated list (1-20 items).`, isError: true }
      }
      const validated = validateTodoList(parsed.data.todos)
      if (!validated.ok) {
        return { content: validated.error, isError: true }
      }
      const next = cloneTodos(validated.todos)
      hooks.getTodos() // keep hook shape symmetric for future persistence
      hooks.onUpdate(next)
      return { content: JSON.stringify(next, null, 2), details: { todos: next } }
    },
  }
}
