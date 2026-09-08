/**
 * @file Node host implementation of the `git.*` tools.
 * @description Canonical implementation shared by the janus CLI and (later)
 * the JanusX shell: same tool names, same input schemas, same action risks
 * (`inspect` for read-only, `write` for stage/unstage/commit, `network` for
 * pull/push). Shells out to the `git` binary directly with bounded outputs.
 * Approval flows through the shared WorkspaceAgentRuntime.
 */
import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  isSensitivePath,
  resolveWorkspaceTarget,
  type RegisteredTool,
  type ToolRegistry,
} from '@janus-agent/agent-core'

const registeredRegistries = new WeakSet<ToolRegistry>()
const MAX_GIT_PATHS = 100
const MAX_STATUS_CHANGES = 500
const MAX_LOG_COUNT = 100
const MAX_DIFF_BYTES = 256 * 1024
const MAX_COMMIT_MESSAGE_CHARS = 500
const OUTPUT_BYTES = 512 * 1024

function runGit(cwd: string, args: string[], signal: AbortSignal, input = ''): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < OUTPUT_BYTES) {
        stdout.push(chunk.subarray(0, OUTPUT_BYTES - stdoutBytes))
        stdoutBytes += chunk.length
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < OUTPUT_BYTES) {
        stderr.push(chunk.subarray(0, OUTPUT_BYTES - stderrBytes))
        stderrBytes += chunk.length
      }
    })
    const abort = () => { try { child.kill() } catch { /* already gone */ } }
    if (signal.aborted) { abort() } else { signal.addEventListener('abort', abort, { once: true }) }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      const code = 'code' in error ? String(error.code) : ''
      reject(code === 'ENOENT'
        ? new Error('git executable not found on PATH; install git to use git.* tools')
        : error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      })
    })
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
}

async function gitOrThrow(cwd: string, args: string[], signal: AbortSignal, toolName: string): Promise<string> {
  const result = await runGit(cwd, args, signal)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with code ${String(result.exitCode)}`
    throw new Error(`${toolName} failed: ${detail.slice(0, 2000)}`)
  }
  return result.stdout
}

function assertWorkspaceId(input: Record<string, unknown>, context: { workspaceId: string }, toolName: string): string {
  if (input.workspaceId !== context.workspaceId) {
    throw new Error(`${toolName} workspaceId must match the active workspace resource`)
  }
  return context.workspaceId
}

async function resolveRepository(
  input: Record<string, unknown>,
  context: { workspaceId: string; workspaceRoot: string; signal: AbortSignal },
  toolName: string,
) {
  const workspaceId = assertWorkspaceId(input, context, toolName)
  const requestedPath = input.path ?? ''
  if (typeof requestedPath !== 'string') throw new Error(`${toolName} path must be a string`)
  const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
  if (target.kind !== 'directory') throw new Error(`${toolName} path must be a directory`)
  const repositoryPath = resolve(context.workspaceRoot, target.relativePath || '.')
  // Fail closed with a model-readable error outside any git repository.
  await gitOrThrow(repositoryPath, ['rev-parse', '--git-dir'], context.signal, toolName).catch((error) => {
    throw new Error(`${toolName} is not inside a git repository: ${error instanceof Error ? error.message : String(error)}`)
  })
  return { workspaceId, path: target.relativePath, repositoryPath }
}

function validateGitPaths(value: unknown, repositoryPath: string, toolName: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GIT_PATHS) {
    throw new Error(`${toolName} paths must contain between 1 and ${MAX_GIT_PATHS} entries`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0') || isAbsolute(item)) {
      throw new Error(`${toolName} contains an invalid path`)
    }
    const normalized = relative(repositoryPath, resolve(repositoryPath, item))
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error(`${toolName} path is outside the repository`)
    }
    if (isSensitivePath(normalized)) throw new Error(`${toolName} cannot access a sensitive path`)
    return normalized.replace(/\\/g, '/')
  })
}

interface StatusChange { path: string; index: string; worktree: string }

function parseStatus(output: string): { branch: string; changes: StatusChange[] } {
  let branch = ''
  const changes: StatusChange[] = []
  for (const line of output.split('\n')) {
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0]
    } else if (line.length > 3) {
      changes.push({ path: line.slice(3), index: line[0] === ' ' ? '' : line[0], worktree: line[1] === ' ' ? '' : line[1] })
    }
  }
  return { branch, changes }
}

export const gitStatusTool: RegisteredTool = {
  name: 'git.status',
  description: 'Read branch and working tree status for a Git repository inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: { workspaceId: { type: 'string' }, path: { type: 'string' } },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.status')
    const output = await gitOrThrow(target.repositoryPath, ['status', '--porcelain=v1', '-b'], context.signal, 'git.status')
    const parsed = parseStatus(output)
    return {
      workspaceId: target.workspaceId,
      path: target.path,
      status: {
        branch: parsed.branch,
        changes: parsed.changes.slice(0, MAX_STATUS_CHANGES),
        truncated: parsed.changes.length > MAX_STATUS_CHANGES,
      },
    }
  },
}

export const gitLogTool: RegisteredTool = {
  name: 'git.log',
  description: 'Read recent commits for a Git repository inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      maxCount: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.log')
    const maxCount = input.maxCount ?? 20
    if (!Number.isSafeInteger(maxCount) || Number(maxCount) < 1 || Number(maxCount) > MAX_LOG_COUNT) {
      throw new Error(`git.log maxCount must be an integer between 1 and ${MAX_LOG_COUNT}`)
    }
    const output = await gitOrThrow(
      target.repositoryPath,
      ['log', `--max-count=${Number(maxCount)}`, '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso', '--no-color'],
      context.signal,
      'git.log',
    )
    const commits = output.split('\n').filter(Boolean).map((line) => {
      const [hash = '', author = '', date = '', subject = ''] = line.split('\x1f')
      return { hash, author, date, subject }
    })
    return { workspaceId: target.workspaceId, path: target.path, commits }
  },
}

export const gitDiffTool: RegisteredTool = {
  name: 'git.diff',
  description: 'Read a bounded working tree or staged Git diff inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      file: { type: 'string' },
      staged: { type: 'boolean' },
      maxBytes: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.diff')
    const maxBytes = input.maxBytes ?? 128 * 1024
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > MAX_DIFF_BYTES) {
      throw new Error(`git.diff maxBytes must be an integer between 1 and ${MAX_DIFF_BYTES}`)
    }
    const file = input.file === undefined ? undefined : validateGitPaths([input.file], target.repositoryPath, 'git.diff')[0]
    const staged = input.staged === true
    const args = ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--staged'] : []), '--', ...(file ? [file] : [])]
    const output = await gitOrThrow(target.repositoryPath, args, context.signal, 'git.diff')
    const bytes = Buffer.byteLength(output, 'utf-8')
    const limit = Number(maxBytes)
    const truncated = bytes > limit
    return {
      workspaceId: target.workspaceId,
      path: target.path,
      file,
      staged,
      diff: truncated ? Buffer.from(output, 'utf-8').subarray(0, limit).toString('utf-8') : output,
      bytes,
      truncated,
    }
  },
}

function cliGitPathsTool(name: 'git.stage' | 'git.unstage'): RegisteredTool {
  const stage = name === 'git.stage'
  return {
    name,
    description: `${stage ? 'Stage' : 'Unstage'} selected paths in a Git repository inside the active workspace`,
    actionRisk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        path: { type: 'string' },
        paths: { type: 'array' },
      },
      required: ['workspaceId', 'paths'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const target = await resolveRepository(input, context, name)
      const paths = validateGitPaths(input.paths, target.repositoryPath, name)
      await gitOrThrow(target.repositoryPath, stage ? ['add', '--', ...paths] : ['restore', '--staged', '--', ...paths], context.signal, name)
      const output = await gitOrThrow(target.repositoryPath, ['status', '--porcelain=v1', '-b'], context.signal, name)
      const parsed = parseStatus(output)
      return {
        workspaceId: target.workspaceId,
        path: target.path,
        paths,
        status: { branch: parsed.branch, changes: parsed.changes.slice(0, MAX_STATUS_CHANGES), truncated: parsed.changes.length > MAX_STATUS_CHANGES },
      }
    },
  }
}

export const gitStageTool = cliGitPathsTool('git.stage')
export const gitUnstageTool = cliGitPathsTool('git.unstage')

export const gitCommitTool: RegisteredTool = {
  name: 'git.commit',
  description: 'Commit the staged changes in a Git repository inside the active workspace',
  actionRisk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['workspaceId', 'message'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.commit')
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > MAX_COMMIT_MESSAGE_CHARS) {
      throw new Error(`git.commit message must contain between 1 and ${MAX_COMMIT_MESSAGE_CHARS} characters`)
    }
    await gitOrThrow(target.repositoryPath, ['commit', '-m', input.message.trim()], context.signal, 'git.commit')
    const output = await gitOrThrow(target.repositoryPath, ['status', '--porcelain=v1', '-b'], context.signal, 'git.commit')
    const parsed = parseStatus(output)
    return {
      workspaceId: target.workspaceId,
      path: target.path,
      status: { branch: parsed.branch, changes: parsed.changes.slice(0, MAX_STATUS_CHANGES), truncated: parsed.changes.length > MAX_STATUS_CHANGES },
    }
  },
}

function cliGitRemoteTool(name: 'git.pull' | 'git.push'): RegisteredTool {
  return {
    name,
    description: `${name === 'git.pull' ? 'Pull from' : 'Push to'} the configured remote for a Git repository inside the active workspace`,
    actionRisk: 'network',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' }, path: { type: 'string' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const target = await resolveRepository(input, context, name)
      await gitOrThrow(target.repositoryPath, [name === 'git.pull' ? 'pull' : 'push'], context.signal, name)
      const output = await gitOrThrow(target.repositoryPath, ['status', '--porcelain=v1', '-b'], context.signal, name)
      const parsed = parseStatus(output)
      return {
        workspaceId: target.workspaceId,
        path: target.path,
        status: { branch: parsed.branch, changes: parsed.changes.slice(0, MAX_STATUS_CHANGES), truncated: parsed.changes.length > MAX_STATUS_CHANGES },
      }
    },
  }
}

export const gitPullTool = cliGitRemoteTool('git.pull')
export const gitPushTool = cliGitRemoteTool('git.push')

export function registerGitTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(gitStatusTool)
  registry.register(gitLogTool)
  registry.register(gitDiffTool)
  registry.register(gitStageTool)
  registry.register(gitUnstageTool)
  registry.register(gitCommitTool)
  registry.register(gitPullTool)
  registry.register(gitPushTool)
  registeredRegistries.add(registry)
}
