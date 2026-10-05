// Note: WorkflowX executes in the shared facade — see .agents/notes/2026-10-05-workflowx-runtime--ac75da81.md
import type { ChatMessage } from '@janus-agent/chat-core'
import type { HarnessMode } from '@janus-agent/harness-core'

export const WORKFLOWX_MODES = ['xdo', 'xdel', 'xflow'] as const
export type WorkflowXMode = HarnessMode
export const WORKFLOWX_DEFAULT_MODE: WorkflowXMode = 'xdo'

export function parseWorkflowXCommand(text: string): { mode: WorkflowXMode; prompt: string } | null {
  const match = /^\s*\/(xdo|xdel|xflow)(?:\s+([\s\S]*))?\s*$/i.exec(text)
  return match ? { mode: match[1].toLowerCase() as WorkflowXMode, prompt: (match[2] ?? '').trim() } : null
}

/** User commands are durable conversation data; tool output and quoted assistant text cannot switch modes. */
export function resolveWorkflowXMode(messages: Pick<ChatMessage, 'role' | 'content'>[]): WorkflowXMode {
  let mode: WorkflowXMode = WORKFLOWX_DEFAULT_MODE
  for (const message of messages) {
    if (message.role !== 'user') continue
    const command = parseWorkflowXCommand(message.content)
    if (command) mode = command.mode
  }
  return mode
}

export function workflowXPrompt(mode: WorkflowXMode): string {
  return [
    `WorkflowX is built in and active. Current engineering mode: ${mode}.`,
    'Apply it to engineering development; ordinary conversation and host-specific product actions keep their own scope.',
    'Before changes, inspect project instructions and search existing .agents/notes by requirement, title and code references. Reuse the owning Note when it fits.',
    'Implement only authorized scope, preserve unrelated edits, verify the real result, and self-review. Record actual checks and unrun checks distinctly.',
    'For code changes, synchronize the owning Note or create a flat .agents/notes Note, add one reverse reference at the code entry, and land code plus Note together. The commit message includes the Note path. Never manufacture verification or completion evidence.',
    'If harness identity is missing, present note.init preview and initialize only within authorized scope; do not overwrite existing identity or silently install project configuration.',
    mode === 'xdo'
      ? 'xdo: execute directly, self-review, and archive the result. A task Note is not required before starting. Do not delegate unless explicitly requested.'
      : mode === 'xdel'
        ? 'xdel: define an accepted task Note with scope, acceptance refs and verification, then call workflow_execute with its URI. The shared executor runs a separate implementor and self-review; no independent evaluator.'
        : 'xflow: discover relevant repository context, clarify unresolved requirements, define accepted task Notes with real dependencies, then call workflow_execute in dependency order. The executor runs a separate implementor and independent evaluator with at most one local repair.',
    'Delegation requires a real execution capability and fixed task evidence. Never impersonate a child agent or label an unrun review as passed.',
    'The user can switch the active mode with /xdo, /xdel, or /xflow; mode selection never grants extra filesystem or execution permissions.',
  ].join('\n')
}
