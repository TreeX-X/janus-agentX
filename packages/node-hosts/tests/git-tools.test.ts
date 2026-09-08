/**
 * node-hosts git.* tests: registration, fail-closed validation and a full
 * status/stage/commit/log/diff round-trip inside a temp repository.
 * Skipped entirely when no `git` binary is on PATH. No network: pull/push
 * are only covered for input validation, never executed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRuntime } from '@janus-agent/agent-core'
import { JobManager } from '../src/jobs.js'
import { registerGitTools } from '../src/git.js'
import { registerNodeHostTools } from '../src/index.js'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function createHarness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'janus-hosts-git-'))
  const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => workspaceRoot })
  registerGitTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'cli', workspaceRoot, approvalMode: 'auto-run' })
  const call = (toolName: string, input: Record<string, unknown>) =>
    runtime.executeTool({ sessionId: session.id, call: { toolName, input } }, 'test')
  return { call, workspaceRoot }
}

function initRepo(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'hosts-test@example.com'], { cwd: workspaceRoot, stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'hosts-test'], { cwd: workspaceRoot, stdio: 'ignore', windowsHide: true })
}

describe.skipIf(!hasGit())('node-hosts git.* tools', () => {
  it('registers all eight git tools', async () => {
    const { call } = await createHarness()
    for (const name of ['git.status', 'git.log', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.pull', 'git.push']) {
      const result = await call(name, name === 'git.commit'
        ? { workspaceId: 'cli', message: 'x' }
        : name === 'git.stage' || name === 'git.unstage'
          ? { workspaceId: 'cli', paths: ['x'] }
          : { workspaceId: 'cli' })
      // Outside a repo every tool fails closed with a model-readable error.
      expect(result.status).toBe('failed')
      expect(String(result.error)).toMatch(/not inside a git repository/)
    }
  }, 30_000)

  it('rejects workspaceId mismatch, absolute paths and bad bounds', async () => {
    const { call } = await createHarness()
    expect((await call('git.status', { workspaceId: 'ghost' })).status).toBe('failed')
    expect((await call('git.stage', { workspaceId: 'cli', paths: ['/abs'] })).status).toBe('failed')
    expect((await call('git.log', { workspaceId: 'cli', maxCount: 101 })).status).toBe('failed')
    expect((await call('git.commit', { workspaceId: 'cli', message: '' })).status).toBe('failed')
  })

  it('runs a status/stage/commit/log/diff round-trip', async () => {
    const { call, workspaceRoot } = await createHarness()
    initRepo(workspaceRoot)
    writeFileSync(join(workspaceRoot, 'note.txt'), 'hello\n')

    const dirty = await call('git.status', { workspaceId: 'cli' })
    expect(dirty.status).toBe('completed')
    expect(JSON.stringify(dirty.output)).toContain('note.txt')

    const staged = await call('git.stage', { workspaceId: 'cli', paths: ['note.txt'] })
    expect(staged.status).toBe('completed')

    const committed = await call('git.commit', { workspaceId: 'cli', message: 'hosts test commit' })
    expect(committed.status).toBe('completed')

    const log = await call('git.log', { workspaceId: 'cli', maxCount: 5 })
    expect(log.status).toBe('completed')
    expect(JSON.stringify(log.output)).toContain('hosts test commit')

    writeFileSync(join(workspaceRoot, 'note.txt'), 'hello again\n')
    const diff = await call('git.diff', { workspaceId: 'cli' })
    expect(diff.status).toBe('completed')
    expect(String((diff.output as Record<string, unknown>).diff)).toContain('hello again')

    const unstageable = await call('git.stage', { workspaceId: 'cli', paths: ['note.txt'] })
    expect(unstageable.status).toBe('completed')
    const unstaged = await call('git.unstage', { workspaceId: 'cli', paths: ['note.txt'] })
    expect(unstaged.status).toBe('completed')
  }, 30_000)

  it('shares the registry with the job manager tools', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'janus-hosts-mix-'))
    const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => workspaceRoot })
    registerGitTools(runtime.registry)
    registerNodeHostTools(runtime.registry, new JobManager())
    for (const name of ['command.run', 'git.status', 'project.process-output']) {
      expect(runtime.registry.get(name), name).toBeDefined()
    }
  })
})
