/**
 * JobManager direct tests: lifecycle, paging, timeout kill, unknown ids and
 * teardown. Tool-level background coverage lives in command-tools.test.ts.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JobManager } from '../src/jobs.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const NODE = 'node'

function workspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'janus-hosts-jobs-'))
}

async function waitFor(manager: JobManager, projectId: string, done: (page: { exited: boolean; timedOut: boolean }) => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const page = await manager.poll(projectId)
    if (done(page)) return
    await sleep(100)
  }
  throw new Error(`job did not settle in time: ${projectId}`)
}

describe('JobManager', () => {
  it('runs a job to completion with a readable log', async () => {
    const manager = new JobManager()
    try {
      const started = await manager.start({
        workspaceRoot: workspaceRoot(), cwd: workspaceRoot(), cwdDisplay: '', program: NODE,
        args: ['-e', 'console.log("job-hi")'], env: {}, label: 'test job',
      })
      expect(started.projectId).toMatch(/^bg-/)
      await waitFor(manager, started.projectId, (page) => page.exited)
      const page = await manager.poll(started.projectId, 50)
      expect(page.exitCode).toBe(0)
      expect(page.timedOut).toBe(false)
      expect(page.output.join('\n')).toContain('job-hi')
      expect(page.logPath).toMatch(/^\.janusX\/logs\/bg-.*\.log$/)
    } finally {
      await manager.dispose()
    }
  }, 30_000)

  it('pages output with offsetLines and reports truncation', async () => {
    const manager = new JobManager()
    try {
      const root = workspaceRoot()
      const started = await manager.start({
        workspaceRoot: root, cwd: root, cwdDisplay: '', program: NODE,
        args: ['-e', 'for (let i = 0; i < 10; i++) console.log("line-" + i)'], env: {}, label: 'paging',
      })
      await waitFor(manager, started.projectId, (page) => page.exited)
      const first = await manager.poll(started.projectId, 4, 0)
      expect(first.totalLines).toBeGreaterThanOrEqual(10)
      expect(first.output.length).toBe(4)
      expect(first.truncated).toBe(true)
      // Log layout: 4 header lines + '--- output ---' separator, then output.
      const second = await manager.poll(started.projectId, 4, 9)
      expect(second.output[0]).toContain('line-4')
      await expect(manager.poll(started.projectId, 0)).rejects.toThrow()
    } finally {
      await manager.dispose()
    }
  }, 30_000)

  it('kills on an explicit timeout and marks timedOut', async () => {
    const manager = new JobManager()
    try {
      const root = workspaceRoot()
      const started = await manager.start({
        workspaceRoot: root, cwd: root, cwdDisplay: '', program: NODE,
        args: ['-e', 'setTimeout(() => {}, 60000)'], env: {}, label: 'timeout', timeoutMs: 1000,
      })
      await waitFor(manager, started.projectId, (page) => page.timedOut)
      const page = await manager.poll(started.projectId)
      expect(page.timedOut).toBe(true)
      expect(page.exited).toBe(true)
    } finally {
      await manager.dispose()
    }
  }, 30_000)

  it('rejects unknown projectIds fail-closed', async () => {
    const manager = new JobManager()
    try {
      await expect(manager.poll('bg-ghost')).rejects.toThrow(/Unknown background job/)
      await expect(manager.stop('bg-ghost')).rejects.toThrow(/Unknown background job/)
    } finally {
      await manager.dispose()
    }
  })

  it('lists jobs and disposes running ones', async () => {
    const manager = new JobManager()
    const root = workspaceRoot()
    const started = await manager.start({
      workspaceRoot: root, cwd: root, cwdDisplay: '', program: NODE,
      args: ['-e', 'setTimeout(() => {}, 60000)'], env: {}, label: 'listed',
    })
    try {
      const listed = manager.list()
      expect(listed.map((job) => job.projectId)).toContain(started.projectId)
      expect(listed.find((job) => job.projectId === started.projectId)?.running).toBe(true)
    } finally {
      await manager.dispose()
    }
    await expect(manager.poll(started.projectId)).rejects.toThrow(/Unknown background job/)
  }, 30_000)
})
