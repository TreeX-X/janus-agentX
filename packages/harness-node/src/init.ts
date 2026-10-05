// Note: explicit initialization is shared by CLI and desktop — see .agents/notes/2026-10-05-workflowx-runtime--ac75da81.md
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createNoteInput } from '@janus-agent/harness-core'
import { SUPPORTED_HARNESS_PROFILE, readHarnessIdentity } from './profile.js'
import { assertAssetPath, withAssetLock } from './transaction.js'
import { sha256HexBytes } from './repository.js'

export interface HarnessInitPlan {
  root: string; repoId: string; existing: boolean
  files: Array<{ path: string; content: string; hash: string }>
}
const previews = new WeakMap<HarnessInitPlan, string>()
const applied = new WeakSet<HarnessInitPlan>()
const undone = new WeakSet<HarnessInitPlan>()
function remember(plan: HarnessInitPlan): HarnessInitPlan {
  previews.set(plan, JSON.stringify(plan))
  return plan
}
function validate(plan: HarnessInitPlan): void {
  if (previews.get(plan) !== JSON.stringify(plan)) throw new Error('Invalid or modified initialization preview')
}
async function checkFiles(plan: HarnessInitPlan): Promise<void> {
  await assertAssetPath(plan.root, '.agents/notes/.init-check')
  for (const file of plan.files) {
    const stat = await lstat(join(plan.root, file.path))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || sha256HexBytes(await readFile(join(plan.root, file.path))) !== file.hash) throw new Error('CONFLICT: initialized files changed')
  }
}

export async function previewHarnessInit(root: string, name = basename(resolve(root))): Promise<HarnessInitPlan> {
  root = resolve(root)
  if (!name.trim() || /[\r\n]/.test(name)) throw new Error('Invalid project name')
  if (!(await lstat(root)).isDirectory()) throw new Error('Project root must be a directory')
  await assertAssetPath(root, '.agents/notes/.init-check')
  try {
    const existing = await lstat(join(root, '.agents/harness.json'))
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Harness identity must be a regular file')
    const identity = await readHarnessIdentity(root)
    if (identity.diagnostics.length || !identity.repoId) throw new Error(identity.diagnostics[0]?.message ?? 'Invalid harness identity')
    return remember({ root, repoId: identity.repoId, existing: true, files: [] })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const repoId = randomUUID()
  const note = createNoteInput('initiative', name, null)
  const files = [
    { path: '.agents/harness.json', content: JSON.stringify({ schemaVersion: 1, repoId, name, profile: SUPPORTED_HARNESS_PROFILE }, null, 2) + '\n' },
    { path: `.agents/notes/${new Date().toISOString().slice(0, 10)}-project--${note.id.slice(0, 8)}.md`, content: note.markdown },
  ].map(file => ({ ...file, hash: sha256HexBytes(Buffer.from(file.content)) }))
  return remember({ root, repoId, existing: false, files })
}

/** Applies only a host-held preview; never accepts file paths or contents from model arguments. */
export async function applyHarnessInit(plan: HarnessInitPlan): Promise<HarnessInitPlan> {
  validate(plan)
  if (undone.has(plan)) throw new Error('Initialization preview was undone; request a new preview')
  if (plan.existing) {
    const current = await previewHarnessInit(plan.root)
    if (current.repoId !== plan.repoId) throw new Error('CONFLICT: harness identity changed')
    return current
  }
  await assertAssetPath(plan.root, '.agents/notes/.init-check')
  return withAssetLock(plan.root, async () => {
    if (applied.has(plan)) { await checkFiles(plan); return plan }
    const written: HarnessInitPlan['files'] = []
    try {
      for (const file of plan.files) {
        if (!(file.path === '.agents/harness.json' || /^\.agents\/notes\/[\w.-]+\.md$/.test(file.path)) || sha256HexBytes(Buffer.from(file.content)) !== file.hash) throw new Error('Invalid initialization preview')
        await assertAssetPath(plan.root, '.agents/notes/.init-check')
        await mkdir(dirname(join(plan.root, file.path)), { recursive: true })
        await writeFile(join(plan.root, file.path), file.content, { flag: 'wx', encoding: 'utf8' })
        written.push(file)
      }
      applied.add(plan)
      return plan
    } catch (error) {
      for (const file of written.reverse()) {
        const path = join(plan.root, file.path)
        if (sha256HexBytes(await readFile(path)) === file.hash) await unlink(path)
      }
      throw error
    }
  })
}

export async function undoHarnessInit(plan: HarnessInitPlan): Promise<void> {
  validate(plan)
  if (plan.existing || undone.has(plan)) return
  if (!applied.has(plan)) throw new Error('Initialization preview has not been applied')
  await withAssetLock(plan.root, async () => {
    await checkFiles(plan)
    const entries = await readdir(join(plan.root, '.agents/notes'))
    const owned = new Set(plan.files.filter(file => file.path.startsWith('.agents/notes/')).map(file => basename(file.path)))
    if (entries.some(name => !owned.has(name))) throw new Error('CONFLICT: project has additional Notes; initialization cannot be undone')
    for (const file of [...plan.files].reverse()) await unlink(join(plan.root, file.path))
    undone.add(plan)
  })
}
