/**
 * @file Public barrel for @janus-agent/node-hosts
 * @description Canonical pure-Node host tools (command.run, git.*, background
 * job project tools) shared by the janus CLI and the JanusX shell. One
 * JobManager per host session owns background jobs; register it alongside the
 * tools on the host's ToolRegistry.
 */
export { JobManager } from './jobs.js'
export type { JobPage, JobStarted, JobStopped, JobStartInput, JobSummary } from './jobs.js'
export {
  commandExecutionMode,
  createCommandRunTool,
  filterCommandEnv,
  registerCommandTools,
  SAFE_COMMAND_ENV_KEYS,
} from './command.js'
export type { NodeCommandExecutionMode } from './command.js'
export {
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPullTool,
  gitPushTool,
  gitStageTool,
  gitStatusTool,
  gitUnstageTool,
  registerGitTools,
} from './git.js'
export { createProjectJobTools, registerProjectJobTools } from './project-jobs.js'
export type { RegisteredTool, ToolRegistry } from '@janus-agent/agent-core'
import type { ToolRegistry } from '@janus-agent/agent-core'
import type { JobManager } from './jobs.js'
import { registerCommandTools } from './command.js'
import { registerGitTools } from './git.js'
import { registerProjectJobTools } from './project-jobs.js'

/** Register command + git + background-job project tools on one registry. */
export function registerNodeHostTools(registry: ToolRegistry, jobs: JobManager): void {
  registerCommandTools(registry, jobs)
  registerGitTools(registry)
  registerProjectJobTools(registry, jobs)
}
