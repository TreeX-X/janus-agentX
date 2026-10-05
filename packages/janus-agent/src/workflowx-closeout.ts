// Note: xdo exposes missing closeout evidence without blocking legacy projects — see .agents/notes/2026-10-05-workflowx-runtime--ac75da81.md
import type { ToolResult } from '@janus-agent/agent-core'

/** Tool receipts provide observations, never proof that a command tested the right behavior. */
export class WorkflowXCloseout {
  private changed = false
  private note = false
  private command = false
  private commit = false

  record(result: ToolResult, input: unknown): void {
    if (result.status !== 'completed') return
    const args = input as Record<string, unknown> | undefined
    const output = result.output as Record<string, unknown> | undefined
    if (['workspace.edit', 'workspace.create', 'workspace.delete'].includes(result.toolName)) {
      const path = String(args?.path ?? output?.path ?? '').replace(/\\/g, '/')
      if (path.startsWith('.agents/notes/')) this.note = true
      else if (path) { this.changed = true; this.command = false; this.commit = false }
    }
    if (result.toolName === 'note.write' && output?.status === 'applied') this.note = true
    if (result.toolName === 'command.run' && output?.ok === true && output?.exitCode === 0 && output?.timedOut !== true) this.command = true
    if (result.toolName === 'git.commit') this.commit = true
  }

  gaps(): string[] {
    if (!this.changed) return []
    return [
      ...(!this.note ? ['Note 归档'] : []),
      ...(!this.command ? ['修改后的检查'] : []),
      ...(!this.commit ? ['Git 提交'] : []),
    ]
  }
}
