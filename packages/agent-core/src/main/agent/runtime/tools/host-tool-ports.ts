/**
 * @file Host tool ports for @janus-agent/agent-core
 * @description project / command / git tools are NOT part of the core: they
 * bind to host-owned services (project runner, git service). Hosts implement
 * these ports and register tools on ToolRegistry. The JanusX shell keeps the
 * original implementations (moved verbatim from src/main/agent/runtime/tools):
 * - project-tools.ts -> ProjectHost + getProjectRunner
 * - command-tools.ts -> CommandHost (requiresCommandShell + run)
 * - git-tools.ts -> GitHost (status/log/diff/stage/unstage/commit/pull/push)
 *
 * Tool-name contract (locked by tests in both repos, see PORTS.md §3):
 * workspace.{read,list,search,edit,create,delete} / project.* / git.* / command.run
 */
import type { ToolRegistry } from '../registry'

export interface ProjectHost {
  detect(cwd: string): Promise<unknown>
  run(input: Record<string, unknown>): Promise<unknown>
  requiresShell(command: string): boolean
}

export interface GitHost {
  status(cwd: string): Promise<unknown>
  log(cwd: string, maxEntries: number): Promise<unknown>
  diff(cwd: string, ref?: string): Promise<unknown>
  stage(cwd: string, paths: string[]): Promise<unknown>
  unstage(cwd: string, paths: string[]): Promise<unknown>
  commit(cwd: string, message: string): Promise<unknown>
  pull(cwd: string): Promise<unknown>
  push(cwd: string): Promise<unknown>
}

export interface CommandHost {
  run(program: string, args: string[], cwd: string, timeoutMs: number): Promise<unknown>
}

export interface HostToolHosts {
  project?: ProjectHost
  git?: GitHost
  command?: CommandHost
}

/**
 * Register host-provided tools. Hosts may call this after registerWorkspaceTools.
 * Tool names reuse the shell's canonical names so blueprints/chat prompts keep working.
 */
export function registerHostTools(_registry: ToolRegistry, _hosts: HostToolHosts): void {
  throw new Error('registerHostTools must be implemented by the host (JanusX shell / janus CLI)')
}
