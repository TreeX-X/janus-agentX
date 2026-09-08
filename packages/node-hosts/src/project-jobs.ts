/**
 * @file Host `project.*` job tools backed by the node-hosts JobManager.
 * @description Same tool names and input shapes as the JanusX shell's
 * Runner-backed tools (`project.list-processes`, `project.process-output`,
 * `project.stop-process`), but reading from the host-local JobManager that
 * backs CLI `command.run background:true` jobs. Read-only polling is
 * `inspect` (no approval); stop is `run` (per-action approval, shell parity).
 */
import type { RegisteredTool, ToolRegistry } from '@janus-agent/agent-core'
import type { JobManager } from './jobs.js'

const registeredRegistries = new WeakSet<ToolRegistry>()

function assertWorkspaceId(input: Record<string, unknown>, context: { workspaceId: string }, toolName: string): void {
  if (input.workspaceId !== context.workspaceId) {
    throw new Error(`${toolName} workspaceId must match the active workspace resource`)
  }
}

export function createProjectJobTools(jobs: JobManager): RegisteredTool[] {
  const listProcesses: RegisteredTool = {
    name: 'project.list-processes',
    description: 'List background command jobs started by command.run in this host session.',
    actionRisk: 'inspect',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      assertWorkspaceId(input, context, 'project.list-processes')
      return { workspaceId: context.workspaceId, processes: jobs.list() }
    },
  }
  const processOutput: RegisteredTool = {
    name: 'project.process-output',
    description: 'Read bounded paged output from one background command job (use offsetLines to page).',
    actionRisk: 'inspect',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        projectId: { type: 'string' },
        maxLines: { type: 'number' },
        offsetLines: { type: 'number' },
      },
      required: ['workspaceId', 'projectId'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      assertWorkspaceId(input, context, 'project.process-output')
      if (typeof input.projectId !== 'string' || !input.projectId) {
        throw new Error('project.process-output projectId must be a non-empty string')
      }
      const page = await jobs.poll(
        input.projectId,
        input.maxLines === undefined ? 100 : Number(input.maxLines),
        input.offsetLines === undefined ? 0 : Number(input.offsetLines),
      )
      return { workspaceId: context.workspaceId, ...page }
    },
  }
  const stopProcess: RegisteredTool = {
    name: 'project.stop-process',
    description: 'Stop one background command job after user approval (idempotent: already-exited jobs succeed).',
    actionRisk: 'run',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        projectId: { type: 'string' },
      },
      required: ['workspaceId', 'projectId'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      assertWorkspaceId(input, context, 'project.stop-process')
      if (typeof input.projectId !== 'string' || !input.projectId) {
        throw new Error('project.stop-process projectId must be a non-empty string')
      }
      const stopped = await jobs.stop(input.projectId)
      return { workspaceId: context.workspaceId, ...stopped }
    },
  }
  return [listProcesses, processOutput, stopProcess]
}

export function registerProjectJobTools(registry: ToolRegistry, jobs: JobManager): void {
  for (const tool of createProjectJobTools(jobs)) {
    if (!registry.get(tool.name)) registry.register(tool)
  }
}
