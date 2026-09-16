import { z } from 'zod'
import type { ExecuteToolInput, ToolResult } from '../../../shared/ipc/agent-runtime'
import type { ToolManifest } from '../runtime/tool-manifest'
import { redactPolicyValue } from '../runtime/policy-gate'
import { toolResultToModelValue } from '../runtime/tool-result'

export interface WorkspaceChatRuntime {
  executeFunctionCall(input: ExecuteToolInput, callerId?: string): Promise<ToolResult>
}

export interface WorkspaceChatToolOptions {
  runtime: WorkspaceChatRuntime
  resources: Map<string, { sessionId: string; workspaceRoot: string; workspaceName: string }>
  callerId: string
  toolManifests?: ToolManifest[]
  onToolResult?: (result: ToolResult) => void
}

function withManifestDescriptions<T extends Record<string, { description: string }>>(tools: T, manifests: ToolManifest[] | undefined): T {
  if (!manifests?.length) return tools
  const descriptions = new Map(manifests.map((manifest) => [manifest.providerName, manifest.description]))
  return Object.fromEntries(Object.entries(tools).map(([providerName, tool]) => [
    providerName,
    descriptions.has(providerName) ? { ...tool, description: descriptions.get(providerName)! } : tool,
  ])) as T
}

/**
 * Convert a runtime result into a payload the model can keep reasoning about.
 * A user denial or a policy rejection is a normal, expected outcome — throwing
 * here would abort the whole streamText call and cut the reply off mid-stream,
 * so every non-completed status becomes structured data instead of an error.
 */
export function createWorkspaceChatTools(options: WorkspaceChatToolOptions) {
  const execute = async (toolName: string, input: Record<string, unknown>) => {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    const resource = options.resources.get(workspaceId)
    if (!resource) {
      return { ok: false, status: 'failed', error: `Workspace "${workspaceId}" is not attached to this Chat` }
    }
    const preview = createToolPreview(toolName, input)
    const result = await options.runtime.executeFunctionCall({
      sessionId: resource.sessionId,
      call: {
        toolName,
        input: { ...input, workspaceId },
        evidenceConfidence: 'medium',
        ...(preview ? { preview } : {}),
      },
    }, options.callerId)
    options.onToolResult?.(result)
    return toolResultToModelValue(result)
  }

  const workspaceId = z.string().min(1).describe('The exact workspaceId from the attached workspace list.')

  const tools = {
    workspace_list: {
      description: 'List a bounded file tree in one attached workspace. Entries carry sizes and modification times with recently modified paths first. Use this before reading when the exact path is unknown.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        depth: z.number().int().min(0).max(4).default(3),
        maxEntries: z.number().int().min(1).max(600).default(300),
        maxTokens: z.number().int().min(1).max(100000).optional().describe('Optional output budget in tokens; tighter than the entry caps when given.'),
      }),
      execute: (input: { workspaceId: string; path: string; depth: number; maxEntries: number; maxTokens?: number }) => execute('workspace.list', input),
    },
    workspace_overview: {
      description: 'Read a shallow bounded tree of one attached workspace with file sizes, modification times, and a git working-tree summary. Start here when the checkout shape is unknown instead of looping workspace_list.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        depth: z.number().int().min(0).max(4).default(2),
        maxEntries: z.number().int().min(1).max(600).default(300),
        maxTokens: z.number().int().min(1).max(100000).optional().describe('Optional output budget in tokens; tighter than the entry caps when given.'),
      }),
      execute: (input: { workspaceId: string; path: string; depth: number; maxEntries: number; maxTokens?: number }) => execute('workspace.overview', input),
    },
    workspace_search: {
      description: 'Search code with path/glob filters and matching line numbers. mode=files locates paths with recently modified files first; content matches carry ±2 context lines and the file SHA-256. Use mode=files to locate paths, regex=true for alternative symbols. Default: literal case-insensitive content search.',
      parameters: z.object({
        workspaceId,
        query: z.string().max(256).default('').describe('Literal text or regex; optional in files mode.'),
        glob: z.string().max(256).optional().describe('Workspace-relative glob, e.g. **/*.ts or src/**.'),
        mode: z.enum(['content', 'files']).default('content'),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        path: z.string().default(''),
        maxResults: z.number().int().min(1).max(100).default(30),
        maxTokens: z.number().int().min(1).max(100000).optional().describe('Optional output budget in tokens; tighter than the match caps when given.'),
      }),
      execute: (input: { workspaceId: string; query: string; path: string; maxResults: number; glob?: string; mode?: string; regex?: boolean; caseSensitive?: boolean; maxTokens?: number }) => execute('workspace.search', input),
    },
    workspace_read: {
      description: 'Read one UTF-8 text file as line pages (files ≤100KB return whole from offset, larger files default 800 lines or 48KB, whichever first). Continue with offset=nextOffset while truncated is true. Read immediately before editing; withLineAnchors:true also returns LINE#HASH anchors per line for lineEdits.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1).describe('Workspace-relative file path, e.g. src/notes/test.md'),
        offset: z.number().int().min(0).default(1).describe('1-indexed line number to start from (default 1).'),
        limit: z.number().int().min(1).max(2000).optional().describe('Max lines to return (default 800; omitted with maxBytes on files ≤100KB returns whole).'),
        maxBytes: z.number().int().min(1).max(256 * 1024).optional().describe('Max bytes of page content (default 49152). The byte cap wins over limit.'),
        maxTokens: z.number().int().min(1).max(100000).optional().describe('Optional output budget in tokens; tighter than the page caps when given.'),
        withLineAnchors: z.boolean().default(false).describe('Also return a LINE#HASH anchor per line (for workspace_edit lineEdits).'),
      }),
      execute: (input: { workspaceId: string; path: string; offset?: number; limit?: number; maxBytes?: number; maxTokens?: number; withLineAnchors?: boolean }) => execute('workspace.read', input),
    },
    workspace_edit: {
      description: 'Edit one existing UTF-8 file with exact, unambiguous replacements, a single-file unified diff, or hash-anchored lineEdits. Requires the SHA-256 returned by workspace_read or by a workspace_search content match when the file is unchanged; the configured Agent permission mode controls approval. lineEdits use LINE#HASH anchors from workspace_read withLineAnchors:true and apply bottom-up; a stale anchor aborts the whole batch and returns fresh anchors to retry with.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/i),
        replacements: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string(),
        })).min(1).max(40).optional(),
        unifiedDiff: z.string().min(1).max(1024 * 1024).optional(),
        lineEdits: z.array(z.object({
          line: z.number().int().min(1).describe('1-indexed line number from the read.'),
          anchor: z.string().regex(/^[a-f0-9]{8}$/i).describe("The line's anchor from workspace_read withLineAnchors (the 8 hex chars after LINE#)."),
          newText: z.string().describe('Replacement for that line; may contain \\n to insert multiple lines.'),
        })).min(1).max(40).optional(),
      }).superRefine((value, context) => {
        if (Number(value.replacements !== undefined) + Number(value.unifiedDiff !== undefined) + Number(value.lineEdits !== undefined) !== 1) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of replacements, unifiedDiff, or lineEdits' })
        }
      }),
      execute: (input: {
        workspaceId: string
        path: string
        expectedHash: string
        replacements?: Array<{ oldText: string; newText: string }>
        unifiedDiff?: string
        lineEdits?: Array<{ line: number; anchor: string; newText: string }>
      }) => execute('workspace.edit', input),
    },
    workspace_create: {
      description: 'Create one new UTF-8 text file in an attached workspace. The parent directory must exist and the file must not. The configured Agent permission mode controls approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1).describe('Workspace-relative path of the new file, e.g. src/notes/test.md'),
        content: z.string().max(1024 * 1024),
      }),
      execute: (input: { workspaceId: string; path: string; content: string }) => execute('workspace.create', input),
    },
    workspace_delete: {
      description: 'Delete one workspace file, symlink, or directory after approval. Directories with entries require recursive:true. The workspace root, .janusX audit state, and sensitive paths are refused. Prefer this over shell rm: the delete is previewed, audited, and checkpointed for restore.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1).describe('Workspace-relative path of the target, e.g. src/notes/old.md'),
        recursive: z.boolean().default(false).describe('Required to delete a directory that still has entries.'),
      }),
      execute: (input: { workspaceId: string; path: string; recursive: boolean }) => execute('workspace.delete', input),
    },
    project_detect: {
      description: 'Detect project types, scripts and candidate project directories in the attached workspace.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        depth: z.number().int().min(0).max(3).default(3),
        maxDirectories: z.number().int().min(1).max(100).default(80),
      }),
      execute: (input: { workspaceId: string; path: string; depth: number; maxDirectories: number }) => execute('project.detect', input),
    },
    project_generate_config: {
      description: 'Generate and validate a JanusX launch configuration proposal without writing it. Explicit user launch intent may override detected project type; use launch for an external script or custom executable.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        projectType: z.string().optional(),
        launch: z.object({
          name: z.string().min(1).optional(),
          program: z.string().min(1),
          args: z.array(z.string()).optional(),
          cwd: z.string().optional(),
          env: z.record(z.string()).optional(),
        }).optional(),
      }),
      execute: (input: {
        workspaceId: string
        path: string
        projectType?: string
        launch?: { name?: string; program: string; args?: string[]; cwd?: string; env?: Record<string, string> }
      }) => execute('project.generate-config', input),
    },
    project_apply_config: {
      description: 'Write a validated JanusX launch configuration to the workspace after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        config: z.record(z.unknown()),
      }),
      execute: (input: { workspaceId: string; path: string; config: Record<string, unknown> }) => execute('project.apply-config', input),
    },
    project_list_processes: {
      description: 'List project processes started and tracked by JanusX in one attached workspace.',
      parameters: z.object({ workspaceId }),
      execute: (input: { workspaceId: string }) => execute('project.list-processes', input),
    },
    project_process_output: {
      description: 'Read recent bounded output from one JanusX-managed project process (supports offsetLines pagination for background command.run jobs).',
      parameters: z.object({
        workspaceId,
        projectId: z.string().min(1),
        maxLines: z.number().int().min(1).max(1000).default(100),
        offsetLines: z.number().int().min(0).max(1000).default(0),
      }),
      execute: (input: { workspaceId: string; projectId: string; maxLines: number; offsetLines: number }) => execute('project.process-output', input),
    },
    project_start_process: {
      description: 'Start a saved JanusX launch configuration after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        configName: z.string().min(1).default('dev'),
      }),
      execute: (input: { workspaceId: string; path: string; configName: string }) => execute('project.start-process', input),
    },
    project_stop_process: {
      description: 'Stop one JanusX-managed project process after user approval. Obtain projectId from project_list_processes.',
      parameters: z.object({
        workspaceId,
        projectId: z.string().min(1),
      }),
      execute: (input: { workspaceId: string; projectId: string }) => execute('project.stop-process', input),
    },
    git_status: {
      description: 'Read the branch and working tree status for a Git repository in an attached workspace.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.status', input),
    },
    git_log: {
      description: 'Read recent commits for a Git repository in an attached workspace.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        maxCount: z.number().int().min(1).max(100).default(20),
      }),
      execute: (input: { workspaceId: string; path: string; maxCount: number }) => execute('git.log', input),
    },
    git_diff: {
      description: 'Read a bounded unstaged or staged Git diff, optionally limited to one repository-relative file.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        file: z.string().min(1).optional(),
        staged: z.boolean().default(false),
        maxBytes: z.number().int().min(1).max(256 * 1024).default(128 * 1024),
      }),
      execute: (input: { workspaceId: string; path: string; file?: string; staged: boolean; maxBytes: number }) => execute('git.diff', input),
    },
    git_stage: {
      description: 'Stage selected repository-relative paths after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        paths: z.array(z.string().min(1)).min(1).max(100),
      }),
      execute: (input: { workspaceId: string; path: string; paths: string[] }) => execute('git.stage', input),
    },
    git_unstage: {
      description: 'Unstage selected repository-relative paths after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        paths: z.array(z.string().min(1)).min(1).max(100),
      }),
      execute: (input: { workspaceId: string; path: string; paths: string[] }) => execute('git.unstage', input),
    },
    git_commit: {
      description: 'Commit staged changes with the exact message supplied or approved by the user.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        message: z.string().min(1).max(500),
      }),
      execute: (input: { workspaceId: string; path: string; message: string }) => execute('git.commit', input),
    },
    git_pull: {
      description: 'Pull from the configured Git remote after user approval.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.pull', input),
    },
    git_push: {
      description: 'Push to the configured Git remote after user approval.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.push', input),
    },
    command_run: {
      description: 'Run one program, package script, or workspace script with structured arguments in an attached workspace. Requires user approval and returns bounded stdout, stderr, exit code, timeout and truncation state. Sync default timeout 120s, max 600s; commands expected to exceed 60s must pass background:true and poll with project_process_output(offsetLines); background jobs have no deadline unless timeoutMs is passed (max 600s) and report timedOut via project_process_output. Optional env allowlist (NODE_ENV/CI/TERM/FORCE_COLOR/NO_COLOR/CLICOLOR/LANG/LC_*/LANGUAGE/TZ, max 32 entries; PATH/LD_PRELOAD and friends are rejected — pass settings as program arguments instead, e.g. git -c http.proxy=...). Sync stdout/stderr are 8KB tail previews; page the full log at logPath with workspace_read. Prefer workspace_delete for removing workspace files (previewed, audited, checkpointed for restore); catastrophic shell deletions are refused fail-closed.',
      parameters: z.object({
        workspaceId,
        cwd: z.string().default(''),
        program: z.string().min(1),
        args: z.array(z.string()).max(100).default([]),
        timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
        background: z.boolean().default(false),
        env: z.record(z.string()).default({}),
      }),
      execute: (input: { workspaceId: string; cwd: string; program: string; args: string[]; timeoutMs: number; background: boolean; env: Record<string, string> }) => execute('command.run', input),
    },
  }
  return withManifestDescriptions(tools, options.toolManifests)
}

function createEditPreview(path: string, value: unknown) {
  const replacements = Array.isArray(value) ? value : []
  const parts = replacements.map((replacement, index) => {
    const item = replacement && typeof replacement === 'object'
      ? replacement as { oldText?: unknown; newText?: unknown }
      : {}
    const oldText = typeof item.oldText === 'string' ? item.oldText : ''
    const newText = typeof item.newText === 'string' ? item.newText : ''
    return [
      `@@ replacement ${index + 1}/${replacements.length} @@`,
      ...oldText.split('\n').map((line) => `-${line}`),
      ...newText.split('\n').map((line) => `+${line}`),
    ].join('\n')
  })
  const fullDetail = [`--- a/${path}`, `+++ b/${path}`, ...parts].join('\n')
  return {
    summary: `Edit ${path} with ${replacements.length} exact replacement${replacements.length === 1 ? '' : 's'}`,
    paths: [path],
    detail: fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createLineEditPreview(path: string, value: unknown) {
  const edits = Array.isArray(value) ? value : []
  const parts = edits.map((edit, index) => {
    const item = edit && typeof edit === 'object'
      ? edit as { line?: unknown; anchor?: unknown; newText?: unknown }
      : {}
    const line = typeof item.line === 'number' ? item.line : '?'
    const newText = typeof item.newText === 'string' ? item.newText : ''
    return [
      `@@ line ${line} (${index + 1}/${edits.length}) @@`,
      ...newText.split('\n').map((text) => `+${text}`),
    ].join('\n')
  })
  const fullDetail = [`--- a/${path}`, `+++ b/${path}`, ...parts].join('\n')
  return {
    summary: `Edit ${path} with ${edits.length} hash-anchored line edit${edits.length === 1 ? '' : 's'}`,
    paths: [path],
    detail: fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createUnifiedDiffPreview(path: string, value: unknown) {
  const diff = typeof value === 'string' ? value : ''
  return {
    summary: `Edit ${path} with a unified diff`,
    paths: [path],
    detail: diff.slice(0, 4_000),
    truncated: diff.length > 4_000,
  }
}

function createCreatePreview(path: string, content: string) {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const fullDetail = [`--- /dev/null`, `+++ b/${path}`, `@@`, ...lines.map((line) => `+${line}`)].join('\n')
  return {
    summary: `Create ${path} (${Buffer.byteLength(content, 'utf-8')} bytes)`,
    paths: [path],
    detail: fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createDeletePreview(path: string, recursive: boolean) {
  // Built pre-execution from input only (kind/size are unknown until the
  // tool resolves the target): the approval dialog names the exact target
  // plus the blast radius the caller requested. The tool re-verifies the
  // census after approval and fails closed on any mismatch.
  const scope = recursive ? ' and its contents' : ''
  const detail = `Deletes ${path}${scope}. Refused for the workspace root, .janusX audit state, and sensitive paths; non-empty directories need recursive:true.`
  return {
    summary: `Delete ${path}${recursive ? ' (recursive)' : ''}`,
    paths: [path],
    detail: detail.slice(0, 4_000),
    truncated: detail.length > 4_000,
  }
}

function createConfigPreview(path: string, value: unknown) {
  const detail = JSON.stringify(redactPolicyValue(value), null, 2)
  return {
    summary: 'Apply JanusX launch configuration' + (path ? ' in ' + path : ''),
    paths: [path ? path + '/.janusX/janusX.launch.json' : '.janusX/janusX.launch.json'],
    detail: detail.slice(0, 4_000),
    truncated: detail.length > 4_000,
  }
}

function createProcessPreview(action: 'Start' | 'Stop', target: string, configName: string) {
  return {
    summary: action + ' JanusX-managed project process',
    paths: [target],
    detail: configName ? 'Configuration: ' + configName : undefined,
    truncated: false,
  }
}

function createGitPreview(action: string, path: string, detail?: string) {
  const fullDetail = detail ?? ''
  return {
    summary: `${action} in Git repository${path ? ` ${path}` : ''}`,
    paths: [path],
    detail: detail === undefined ? undefined : fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createGitPathsPreview(action: string, repositoryPath: string, value: unknown) {
  const paths = Array.isArray(value) ? value.map(String) : []
  const detail = JSON.stringify(paths)
  return {
    summary: `${action} in Git repository${repositoryPath ? ` ${repositoryPath}` : ''}`,
    paths: paths.slice(0, 20),
    detail: detail.slice(0, 4_000),
    truncated: paths.length > 20 || detail.length > 4_000,
  }
}

function createCommandPreview(input: Record<string, unknown>) {
  const program = String(input.program ?? '')
  const args = Array.isArray(input.args) ? input.args.map(String) : []
  const cwd = String(input.cwd ?? '')
  // R4：env 进审批预览（经 redactPolicyValue，凭证形值显示脱敏），审批人可见覆盖了哪些变量。
  const detail = JSON.stringify(redactPolicyValue({ program, args, cwd, timeoutMs: input.timeoutMs, background: input.background ?? false, env: input.env ?? {} }), null, 2)
  return {
    summary: `Run ${program || 'workspace command'}${input.background === true ? ' in background' : ''}`,
    paths: [cwd],
    detail: detail.slice(0, 4_000),
    truncated: detail.length > 4_000,
  }
}

export function createToolPreview(toolName: string, input: Record<string, unknown>) {
  const path = String(input.path ?? '')
  switch (toolName) {
    case 'workspace.edit': return input.unifiedDiff !== undefined
      ? createUnifiedDiffPreview(path, input.unifiedDiff)
      : input.lineEdits !== undefined
        ? createLineEditPreview(path, input.lineEdits)
        : createEditPreview(path, input.replacements)
    case 'workspace.create': return createCreatePreview(path, String(input.content ?? ''))
    case 'workspace.delete': return createDeletePreview(path, input.recursive === true)
    case 'project.apply-config': return createConfigPreview(path, input.config)
    case 'project.start-process': return createProcessPreview('Start', path, String(input.configName ?? 'dev'))
    case 'project.stop-process': return createProcessPreview('Stop', String(input.projectId ?? ''), '')
    case 'git.stage': return createGitPathsPreview('Stage selected paths', path, input.paths)
    case 'git.unstage': return createGitPathsPreview('Unstage selected paths', path, input.paths)
    case 'git.commit': return createGitPreview('Commit staged changes', path, String(input.message ?? ''))
    case 'git.pull': return createGitPreview('Pull remote changes', path)
    case 'git.push': return createGitPreview('Push local commits', path)
    case 'command.run': return createCommandPreview(input)
    default: return undefined
  }
}
