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
})
