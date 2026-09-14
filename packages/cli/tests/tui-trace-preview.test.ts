/**
 * Post-turn file previews: git diffs, new-file content, safe fallbacks.
 * Real throwaway git repos under tmp; no network, no home-dir writes.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTracePreviews, previewFileChange } from '../src/trace-preview.js'

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 15000 })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-preview-'))
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'test@janus.local'])
  git(dir, ['config', 'user.name', 'janus-test'])
  return dir
}

describe('previewFileChange', () => {
  it('renders a bounded unified diff for tracked modifications', () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git(dir, ['add', 'a.txt'])
    git(dir, ['commit', '-m', 'init'])
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    const preview = previewFileChange(dir, 'a.txt')
    expect(preview).toContain('-two')
    expect(preview).toContain('+TWO')
    expect(preview.some((line) => /\(\+\d+ -\d+\)/.test(line))).toBe(true)
    expect(preview.some((line) => line.startsWith('+++'))).toBe(false)
  })

  it('renders new-file content for untracked creates', () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    git(dir, ['add', 'a.txt'])
    git(dir, ['commit', '-m', 'init'])
    writeFileSync(join(dir, 'new.txt'), 'hello\nworld\n')
    const preview = previewFileChange(dir, 'new.txt')
    expect(preview).toContain('+hello')
    expect(preview.some((line) => line.includes('new file'))).toBe(true)
  })

  it('degrades to empty outside git repos or the workspace root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-preview-plain-'))
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    expect(previewFileChange(dir, 'a.txt')).toEqual([])
    expect(previewFileChange(dir, '../escape.txt')).toEqual([])
  })
})

describe('buildTracePreviews', () => {
  it('attaches summaries always and diffs only for file mutations', () => {
    const dir = initRepo()
    const previews = buildTracePreviews(dir, [
      { toolName: 'workspace.edit', workspaceId: 'cli', status: 'completed', summary: 'Edit a.ts' },
      { toolName: 'workspace.search', workspaceId: 'cli', status: 'completed', summary: '3 matches' },
    ])
    expect(previews).toHaveLength(2)
    expect(previews[0].summary).toBe('Edit a.ts')
    expect(previews[0].diff).toEqual([])
    expect(previews[1]).toMatchObject({ summary: '3 matches', diff: [] })
  })

  it('prefers the per-call diff with a checkpoint header outside repos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-preview-plain-'))
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    const previews = buildTracePreviews(dir, [{
      toolName: 'workspace.edit',
      workspaceId: 'cli',
      status: 'completed',
      summary: 'a.txt, sha256=abc, checkpoint=checkpoint-abcdef123456',
      argsDigest: 'a.txt',
      diffPreview: '--- a/a.txt\n+++ b/a.txt\n@@ replacement 1/1 @@\n-x\n+y',
      checkpointId: 'checkpoint-abcdef123456',
    }])
    expect(previews).toHaveLength(1)
    expect(previews[0].summary).toBe('a.txt · (+1 -1) · checkpoint checkpoi')
    expect(previews[0].diff).toContain('-x')
    expect(previews[0].diff).toContain('+y')
    expect(previews[0].diff.at(-1)).toBe('checkpoint checkpoi · 可撤销')
    expect(previews[0].checkpointId).toBe('checkpoint-abcdef123456')
  })

  it('attributes each same-file call to its own diff instead of the cumulative git diff', () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git(dir, ['add', 'a.txt'])
    git(dir, ['commit', '-m', 'init'])
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    const previews = buildTracePreviews(dir, [
      {
        toolName: 'workspace.edit', workspaceId: 'cli', status: 'completed',
        summary: 'first', argsDigest: 'a.txt',
        diffPreview: '--- a/a.txt\n+++ b/a.txt\n@@ replacement 1/1 @@\n-two\n+TWO',
        checkpointId: 'cp-first',
      },
      {
        toolName: 'workspace.edit', workspaceId: 'cli', status: 'completed',
        summary: 'second', argsDigest: 'a.txt',
        diffPreview: '--- a/a.txt\n+++ b/a.txt\n@@ replacement 1/1 @@\n-TWO\n+three',
        checkpointId: 'cp-second',
      },
    ])
    expect(previews[0].diff).toContain('+TWO')
    expect(previews[0].diff).not.toContain('+three')
    expect(previews[1].diff).toContain('+three')
    expect(previews[1].diff).not.toContain('+TWO')
    expect(previews[0].summary).toContain('checkpoint cp-first')
    expect(previews[1].summary).toContain('checkpoint cp-secon')
  })
})
