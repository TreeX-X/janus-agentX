import { describe, expect, it } from 'vitest'
import type { ToolResult } from '../src/shared/ipc/agent-runtime'
import { toolResultToModelValue } from '../src/main/agent/runtime/tool-result'

function completed(toolName: string, output: unknown): ToolResult {
  return {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    correlationId: 'call-1',
    toolName,
    status: 'completed',
    startedAt: '2026-09-06T00:00:00.000Z',
    completedAt: '2026-09-06T00:00:00.001Z',
    durationMs: 1,
    summary: 'completed',
    output,
  }
}

// Note: opencode-style plain-text model values — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
// Structured outputs stay complete in details/traces/UI; the model only
// re-reads these texts, so assertions check header-first plain text.
describe('toolResultToModelValue plain-text (opencode parity)', () => {
  it('renders command.run refs-first as text with a logPath pointer, never a re-run invite', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      ok: false,
      exitCode: 1,
      stdout: 'tail-preview',
      stderr: 'err-preview',
      timedOut: false,
      outputTruncated: true,
      executionMode: 'direct',
      totalBytes: 70000,
      wallTimeMs: 1200,
      logTruncated: false,
      logPath: '.janusX/logs/cmd-1.log',
    })) as string
    expect(typeof value).toBe('string')
    expect(value.indexOf('$ npm run build exit=1')).toBe(0)
    expect(value).toContain('.janusX/logs/cmd-1.log')
    expect(value).toContain('workspace_read')
    expect(value.indexOf('.janusX/logs/cmd-1.log')).toBeLessThan(value.indexOf('tail-preview'))
    expect(value).not.toContain('workspaceId')
    expect(value).not.toContain('estimatedTokens')
  })

  it('keeps background projectId/logPath and drops absent stdout/exitCode', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
      logPath: '.janusX/logs/bg-1.log',
    })) as string
    expect(value).toContain('job=pid-1')
    expect(value).toContain('.janusX/logs/bg-1.log')
    expect(value).toContain('project_process_output')
    expect(value).not.toContain('exit=')
  })

  it('drops env echoes from the model text (approval preview still carries them)', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
      env: { NODE_ENV: 'production' },
      logPath: '.janusX/logs/bg-1.log',
      stdout: 'tail-preview',
    })) as string
    expect(value).not.toContain('NODE_ENV')
    expect(value).toContain('job=pid-1')
  })

  it('points background jobs without a log file at project_process_output', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
    })) as string
    expect(value).toContain('project_process_output')
  })

  it('renders process-output paging refs as a header line with a hint when truncated', () => {
    const value = toolResultToModelValue(completed('project.process-output', {
      workspaceId: 'workspace-1',
      projectId: 'pid',
      output: 'page-text',
      totalLines: 900,
      offsetLines: 0,
      truncated: true,
    })) as string
    expect(value.indexOf('lines=0/900')).toBeGreaterThanOrEqual(0)
    expect(value.indexOf('lines=0/900')).toBeLessThan(value.indexOf('page-text'))
    expect(value).toContain('offsetLines')
  })

  it('renders workspace.read as numbered lines with range+sha header and next-offset hint', () => {
    const sha = 'a'.repeat(64)
    const value = toolResultToModelValue(completed('workspace.read', {
      workspaceId: 'workspace-1',
      path: 'big.ts',
      lineStart: 1,
      lineEnd: 2,
      totalLines: 1000,
      offset: 1,
      bytes: 9000,
      size: 45000,
      truncated: true,
      nextOffset: 3,
      sha256: sha,
      content: 'line-one\nline-two',
    })) as string
    expect(value).toContain('<path>big.ts</path>')
    expect(value).toContain('lines 1-2/1000')
    expect(value).toContain(`sha=${sha}`)
    expect(value).toContain('1: line-one')
    expect(value).toContain('offset=3')
    expect(value).not.toContain('workspace-1')
    expect(value).not.toContain('estimatedTokens')
  })

  it('renders workspace.search flat hits grouped by file with the first-hit sha', () => {
    const sha = 'b'.repeat(64)
    const value = toolResultToModelValue(completed('workspace.search', {
      workspaceId: 'workspace-1',
      query: 'needle',
      path: '',
      matches: [
        { path: 'a.ts', line: 12, text: 'const needle = 1', sha256: sha },
        { path: 'a.ts', line: 30, text: 'needle()' },
        { path: 'b.ts', line: 3, text: 'needle' },
      ],
      truncated: false,
    })) as string
    expect(value).toContain('Found 3 matches for "needle"')
    expect(value).toContain(`a.ts: [sha=${sha}]`)
    expect(value).toContain(' Line 12: const needle = 1')
    expect(value).toContain(' Line 30: needle()')
    expect(value).not.toContain('workspace-1')
  })

  it('renders workspace.list entries as plain paths without token echoes', () => {
    const value = toolResultToModelValue(completed('workspace.list', {
      workspaceId: 'workspace-1',
      path: '',
      depth: 2,
      entries: [
        { path: 'src', name: 'src', type: 'directory', depth: 1, size: 0, mtime: 1 },
        { path: 'src/a.ts', name: 'a.ts', type: 'file', depth: 2, size: 12, mtime: 2 },
      ],
      truncated: false,
    })) as string
    expect(value).toContain('src/')
    expect(value).toContain('src/a.ts (12b)')
    expect(value).not.toContain('workspace-1')
    expect(value).not.toContain('estimatedTokens')
  })

  it('keeps mutation results to one line and display diffs out of the model payload', () => {
    const sha = 'c'.repeat(64)
    const value = toolResultToModelValue(completed('workspace.edit', {
      workspaceId: 'workspace-1',
      path: 'a.ts',
      changedPaths: ['a.ts'],
      previousHash: 'x',
      sha256: sha,
      editMode: 'replace_blocks',
      replacements: 1,
      bytes: 10,
      checkpointId: 'cp-1',
      diffPreview: '--- a/a.ts\n+++ b/a.ts\n@@ replacement 1/1 @@\n-x\n+y',
      diffTruncated: false,
    })) as string
    expect(value).toBe(`Edited a.ts sha=${sha} checkpoint=cp-1`)
    expect(value).not.toContain('@@')
  })
})
