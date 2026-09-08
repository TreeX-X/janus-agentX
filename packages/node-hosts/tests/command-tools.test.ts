/**
 * node-hosts command.run tests: registration, fail-closed validation, sync
 * execution, timeout kill, env allowlist, log persistence, background jobs
 * and per-action approval wiring. Real WorkspaceAgentRuntime over a temp
 * workspace (no network, no model).
 */
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRuntime } from '@janus-agent/agent-core'
import { JobManager } from '../src/jobs.js'
import { registerCommandTools } from '../src/command.js'
import { registerProjectJobTools } from '../src/project-jobs.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createHarness(approvalMode: 'auto-run' | 'per-action' = 'auto-run') {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'janus-hosts-cmd-'))
  const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => workspaceRoot })
  const jobs = new JobManager()
  registerCommandTools(runtime.registry, jobs)
  registerProjectJobTools(runtime.registry, jobs)
  const session = await runtime.createSession({ workspaceId: 'cli', workspaceRoot, approvalMode })
  const call = (toolName: string, input: Record<string, unknown>, callerId = 'test', extra: Record<string, unknown> = {}) =>
    runtime.executeTool({ sessionId: session.id, call: { toolName, input, ...extra } }, callerId)
  return { runtime, session, call, jobs, workspaceRoot }
}

describe('node-hosts command.run registration', () => {
  it('registers command.run plus the three job project tools', async () => {
    const { runtime } = await createHarness()
    for (const name of ['command.run', 'project.list-processes', 'project.process-output', 'project.stop-process']) {
      expect(runtime.registry.get(name), name).toBeDefined()
    }
  })

  it('rejects unknown tools and off-schema input fail-closed', async () => {
    const { call } = await createHarness()
    const unknown = await call('command.rm', { workspaceId: 'cli', program: 'x' })
    expect(unknown.status).toBe('failed')
    const extra = await call('command.run', { workspaceId: 'cli', program: 'node', bogus: 1 })
    expect(extra.status).toBe('failed')
  })
})

describe('node-hosts command.run validation', () => {
  it('rejects workspaceId mismatch, absolute program and bad timeout', async () => {
    const { call } = await createHarness()
    expect((await call('command.run', { workspaceId: 'ghost', program: 'node' })).status).toBe('failed')
    expect((await call('command.run', { workspaceId: 'cli', program: '/bin/echo' })).status).toBe('failed')
    expect((await call('command.run', { workspaceId: 'cli', program: 'node', timeoutMs: 999_999 })).status).toBe('failed')
  })

  it('rejects non-allowlisted env keys fail-closed', async () => {
    const { call } = await createHarness()
    const result = await call('command.run', { workspaceId: 'cli', program: 'node', env: { PATH: '/x' } })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/allowlisted/)
  })
})

describe('node-hosts command.run execution', () => {
  it('runs node and returns exit code plus output', async () => {
    const { call } = await createHarness()
    const result = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'console.log("hi-hosts")'],
    })
    expect(result.status).toBe('completed')
    const output = result.output as Record<string, unknown>
    expect(output.exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(String(output.stdout)).toContain('hi-hosts')
    expect(typeof output.wallTimeMs).toBe('number')
  })

  it('passes allowlisted env through', async () => {
    const { call } = await createHarness()
    const result = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'console.log(process.env.NODE_ENV)'], env: { NODE_ENV: 'hosts-test' },
    })
    expect(result.status).toBe('completed')
    expect(String((result.output as Record<string, unknown>).stdout)).toContain('hosts-test')
  })

  it('reports nonzero exit without failing the tool call', async () => {
    const { call } = await createHarness()
    const result = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'process.exit(3)'],
    })
    expect(result.status).toBe('completed')
    const output = result.output as Record<string, unknown>
    expect(output.exitCode).toBe(3)
    expect(output.ok).toBe(false)
  })

  it('kills on timeout and reports timedOut', async () => {
    const { call } = await createHarness()
    const result = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 1000,
    })
    expect(result.status).toBe('completed')
    const output = result.output as Record<string, unknown>
    expect(output.timedOut).toBe(true)
    expect(output.ok).toBe(false)
  })

  it('persists the full log and marks truncation past 8KB', async () => {
    const { call, workspaceRoot } = await createHarness()
    const result = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'console.log("x".repeat(20000))'],
    })
    expect(result.status).toBe('completed')
    const output = result.output as Record<string, unknown>
    expect(output.outputTruncated).toBe(true)
    expect(typeof output.logPath).toBe('string')
    expect(existsSync(join(workspaceRoot, String(output.logPath)))).toBe(true)
  })
})

describe('node-hosts command.run background', () => {
  it('starts a job polled to completion via project.process-output', async () => {
    const { call, jobs } = await createHarness()
    const started = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'console.log("bg-hi")'], background: true,
    })
    expect(started.status).toBe('completed')
    const output = started.output as Record<string, unknown>
    expect(output.background).toBe(true)
    expect(typeof output.projectId).toBe('string')
    expect(typeof output.logPath).toBe('string')
    const projectId = String(output.projectId)
    for (let i = 0; i < 100 && !(await jobs.poll(projectId)).exited; i++) await sleep(100)
    const page = await call('project.process-output', { workspaceId: 'cli', projectId, maxLines: 50 })
    expect(page.status).toBe('completed')
    const body = page.output as Record<string, unknown>
    expect(body.exited).toBe(true)
    expect(body.exitCode).toBe(0)
    expect(JSON.stringify(body.output)).toContain('bg-hi')
  }, 30_000)

  it('reports timedOut for background jobs past an explicit timeoutMs', async () => {
    const { call, jobs } = await createHarness()
    const started = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'setTimeout(() => {}, 30000)'], background: true, timeoutMs: 1000,
    })
    expect(started.status).toBe('completed')
    const projectId = String((started.output as Record<string, unknown>).projectId)
    let page = await jobs.poll(projectId)
    for (let i = 0; i < 100 && !page.timedOut; i++) {
      await sleep(100)
      page = await jobs.poll(projectId)
    }
    expect(page.timedOut).toBe(true)
    expect(page.exited).toBe(true)
  }, 30_000)

  it('stops a running job via project.stop-process (idempotent)', async () => {
    const { call } = await createHarness()
    const started = await call('command.run', {
      workspaceId: 'cli', program: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], background: true,
    })
    const projectId = String((started.output as Record<string, unknown>).projectId)
    const stopped = await call('project.stop-process', { workspaceId: 'cli', projectId })
    expect(stopped.status).toBe('completed')
    expect((stopped.output as Record<string, unknown>).stopped).toBe(true)
    const again = await call('project.stop-process', { workspaceId: 'cli', projectId })
    expect(again.status).toBe('completed')
    expect((again.output as Record<string, unknown>).exited).toBe(true)
    const listed = await call('project.list-processes', { workspaceId: 'cli' })
    expect(listed.status).toBe('completed')
    expect(JSON.stringify(listed.output)).toContain(projectId)
  }, 30_000)

  it('rejects unknown projectIds fail-closed', async () => {
    const { call } = await createHarness()
    expect((await call('project.process-output', { workspaceId: 'cli', projectId: 'bg-ghost' })).status).toBe('failed')
    expect((await call('project.stop-process', { workspaceId: 'cli', projectId: 'bg-ghost' })).status).toBe('failed')
  })
})

describe('node-hosts command.run approval', () => {
  it('asks per-action approval and executes on approve', async () => {
    const { runtime, session, call } = await createHarness('per-action')
    // The chat path attaches preview at call level (createWorkspaceChatTools);
    // the runtime requires one for external-command before asking approval.
    const preview = { summary: 'Run node', paths: [''], truncated: false }
    const pending = call('command.run', { workspaceId: 'cli', program: 'node', args: ['-e', 'console.log(1)'] }, 'test', { preview })
    const requested = await new Promise<{ id: string; correlationId: string }>((resolve) => {
      const off = runtime.onEvent((event) => {
        const typed = event as { type?: string; request?: { id?: string; sessionId?: string; correlationId?: string } }
        if (typed.type === 'approval-requested' && typed.request?.sessionId === session.id) {
          off()
          resolve({ id: String(typed.request?.id), correlationId: String(typed.request?.correlationId) })
        }
      })
    })
    expect(runtime.resolveApproval({
      approvalId: requested.id, approved: true, workspaceId: 'cli',
      sessionId: session.id, correlationId: requested.correlationId, toolName: 'command.run', actionRisk: 'external-command',
    }, 'test')).toBe(true)
    const result = await pending
    expect(result.status).toBe('completed')
  }, 30_000)

  it('safe-compile commands skip per-action approval via AUTO_RUN_ALLOWED', async () => {
    const { call } = await createHarness('per-action')
    const result = await call('command.run', { workspaceId: 'cli', program: 'npm', args: ['run', 'test'] })
    // npm may not exist here; what matters is no approval gate stopped it.
    expect(['completed', 'failed']).toContain(result.status)
    expect(result.reasonCode).not.toBe('APPROVAL_DENIED')
    expect(result.reasonCode).not.toBe('APPROVAL_CANCELLED')
  })
})
