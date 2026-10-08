// Note: maintained module adoption - see .agents/notes/harness/workflowx-v2-adoption.md
// Note: WorkflowX executes in the shared facade — see .agents/notes/harness/storage/history/workflowx-runtime.md
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
    'For code changes, maintain the owning module document in place; create a stable topic Note only when needed, add one reverse reference at the code entry, and land code plus Note together. The commit message includes the Note path. Never manufacture verification or completion evidence.',
    'If harness identity is missing, present note.init preview and initialize only within authorized scope; do not overwrite existing identity or silently install project configuration.',
    mode === 'xdo'
      ? 'xdo: execute directly, self-review, and archive the result. Do not create a Task. An explicitly selected existing Task retains acceptance and review obligations. Do not delegate unless explicitly requested.'
      : mode === 'xdel'
        ? 'xdel: use an accepted Task and call workflow_execute once. coderX uses engineeringX/specX and self-review, returning Change Summary + Note draft. No evaluator is dispatched; any existing independent-review obligation remains pending.'
        : 'xflow: repository discovery -> socratesX -> Ready Summary -> accepted Tasks -> dependency-ordered dispatch. coderX returns Change Summary + Note draft; evaluatorX runs focused checks against fixed AC and returns Evaluation Result. At most one automatic local repair.',
    'Use one module.md per module; parent explanations, topic Notes and submodules coexist. Preserve created and refresh updated on maintenance. Convert Ideas in place; expand or merge modules only when responsibilities warrant it. Stay within user-discussed modules and repair references during reorganization. Only Main Agent writes Tasks; children read all Task metadata and prose without mutation. Before each handoff integrate Progress (verified/unverified facts), Evidence (result references), Handoff (blockers/next action) once, without duplicating execution fields. Preserve work.review across mode changes.',
    'Delegation requires a real execution capability and fixed task evidence. Never impersonate a child agent or label an unrun review as passed.',
    'The user can switch the active mode with /xdo, /xdel, or /xflow; mode selection never grants extra filesystem or execution permissions.',
  ].join('\n')
}
