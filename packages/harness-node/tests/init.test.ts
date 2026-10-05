import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewHarnessInit, applyHarnessInit, undoHarnessInit } from '../src/init.js'
import { buildNoteIndex } from '../src/index.js'

const roots: string[] = []
async function root() { const value = await mkdtemp(join(tmpdir(), 'wfx-init-')); roots.push(value); return value }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }) })
describe('shared explicit initialization', () => {
  it('previews without writes, applies a valid identity and Note, and supports idempotent undo', async () => {
    const path = await root()
    const plan = await previewHarnessInit(path, 'Project')
    expect(await readdir(path)).toEqual([])
    await applyHarnessInit(plan)
    await applyHarnessInit(plan)
    const index = await buildNoteIndex(path)
    expect(index.repoId).toBe(plan.repoId)
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0].diagnostics).toEqual([])
    await undoHarnessInit(plan)
    await undoHarnessInit(plan)
    await expect(readFile(join(path, '.agents/harness.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves an existing identity and refuses stale or forged previews', async () => {
    const path = await root()
    const plan = await previewHarnessInit(path)
    const competing = await previewHarnessInit(path)
    await applyHarnessInit(plan)
    const bytes = await readFile(join(path, '.agents/harness.json'), 'utf8')
    const existing = await previewHarnessInit(path)
    expect(existing).toMatchObject({ existing: true, repoId: plan.repoId, files: [] })
    await applyHarnessInit(existing)
    await undoHarnessInit(existing)
    await expect(applyHarnessInit(competing)).rejects.toThrow()
    await expect(undoHarnessInit({ ...plan })).rejects.toThrow('preview')
    expect(await readFile(join(path, '.agents/harness.json'), 'utf8')).toBe(bytes)
  })
  it('refuses undo after edits or added Notes', async () => {
    const path = await root(); const plan = await previewHarnessInit(path)
    await applyHarnessInit(plan)
    await writeFile(join(path, '.agents/notes/another.md'), 'user content')
    await expect(undoHarnessInit(plan)).rejects.toThrow('additional Notes')
    await rm(join(path, '.agents/notes/another.md'))
    await writeFile(join(path, plan.files[1].path), 'changed')
    await expect(undoHarnessInit(plan)).rejects.toThrow('changed')
  })
  it('refuses linked asset directories and modified host previews', async () => {
    const path = await root(); const outside = await root()
    await symlink(outside, join(path, '.agents'), 'junction')
    await expect(previewHarnessInit(path)).rejects.toThrow('linked')
    const clean = await root(); const plan = await previewHarnessInit(clean)
    plan.files[0].path = '../outside'
    await expect(applyHarnessInit(plan)).rejects.toThrow('modified')
    expect(await readdir(clean)).toEqual([])
  })
})
