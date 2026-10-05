// Note: shared engineering capabilities and host extensions — see .agents/notes/2026-10-05-workflowx-runtime--ac75da81.md
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { parseNote, NOTE_URI_RE } from '@janus-agent/harness-core'
import { listPendingTx, readCommitted, readJournal } from './index.js'
import { NoteService, noteService } from './note-service.js'
import { createNoteOp, mergeNoteEdit, type NoteEdit } from '@janus-agent/harness-core'
import { previewUndo } from './undo.js'

export interface NoteChatChange {
  id: string
  conversationId: string
  workspacePath: string
  reason: string
  createdAt: string
  txId?: string
  reverted?: boolean
  files: Array<{ uri: string; title: string; before: string; after: string }>
}


const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const rootKey = (root: string) => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
const directory = (root: string, conversationId: string) => join(root, '.agents', '.local', 'note-chat', hash(conversationId))

/** Discussion is read-only unless the current user turn actually requests a mutation. */
export function hasNoteMutationIntent(text: string): boolean {
  if (/(?:不要|不必|先别|暂不|不允许|先不|暂时不|不|do not|don't|without)\s*(?:修改|更新|编辑|新增|新建|写入|保存|创建|记录|改|edit|update|create|add|record|rename|replace|write|modify|save|change)/i.test(text)) return false
  if (/(?:分析|讨论|解释|建议|如何|怎么|怎样|是否|能否|analy[sz]e|discuss|explain|suggest|how (?:to|would|should))/i.test(text)
    && !/(?:直接|立即|现在|然后|并且|并|please)\s*(?:修改|更新|创建|新增|保存|写入|edit|update|create|save)/i.test(text)) return false
  return /(?:实施|实现|修复|重构|修改|更新|编辑|新增|新建|创建|写入|保存|记录到|补充|补上|改成|改为|改一下|按.{0,30}(?:调整|执行|更新)|\b(?:implement|fix|refactor|edit|update|create|write|save|rename|replace|add|record)\b)/i.test(text)
}

const operationSchema = z.object({
  type: z.enum(['create', 'update']),
  uri: z.string().regex(NOTE_URI_RE).optional(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  kind: z.enum(['idea', 'initiative', 'requirement', 'decision', 'task']).optional(),
  title: z.string().trim().min(1).max(300).refine(value => !/[\r\n]/.test(value)).optional(),
  sections: z.record(z.string().max(200_000)).default({}),
  tags: z.array(z.string().max(100)).max(32).optional(),
  parent: z.string().regex(NOTE_URI_RE).nullable().optional(),
  lifecycle: z.enum(['draft', 'proposed', 'accepted', 'archived', 'rejected']).optional(),
  work: z.record(z.unknown()).optional(),
  relations: z.array(z.record(z.unknown())).optional(),
  codeRefs: z.array(z.record(z.unknown())).optional(),
}).strict()
const writeSchema = z.object({ reason: z.string().trim().min(1).max(1000), operations: z.array(operationSchema).min(1).max(16) }).strict()
const changeSchema = z.object({
  id: z.string().uuid(), conversationId: z.string(), workspacePath: z.string(), reason: z.string(), createdAt: z.string().datetime(),
  txId: z.string().regex(/^[a-zA-Z0-9-]+$/).optional(), reverted: z.boolean().optional(),
  files: z.array(z.object({ uri: z.string().regex(NOTE_URI_RE), title: z.string(), before: z.string(), after: z.string() })).min(1).max(16),
})

async function saveChange(change: NoteChatChange): Promise<void> {
  const dir = directory(change.workspacePath, change.conversationId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${change.id}.json`)
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(change), 'utf8')
  await rename(temporary, file)
}

/** A prewritten record plus the transaction journal survives a lost completion event. */
export async function listNoteChatChanges(root: string, conversationId: string): Promise<NoteChatChange[]> {
  const dir = directory(root, conversationId)
  const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })
  const changes: NoteChatChange[] = []
  for (const name of names.filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
    const change: NoteChatChange = changeSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8')))
    if (change.conversationId !== conversationId || rootKey(change.workspacePath) !== rootKey(root)) continue
    if (!change.txId) {
      for (const txId of await listPendingTx(root)) {
        if ((await readJournal(root, txId))?.changeSetId === change.id && await readCommitted(root, txId)) { change.txId = txId; break }
      }
    }
    if (change.txId && await readCommitted(root, change.txId)) {
      const { preview } = await previewUndo(root, change.txId)
      change.reverted = !!preview?.files.length && preview.files.every(file => file.status === 'already-reverted')
      changes.push(change)
    }
  }
  return changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export class NoteChatEditor {
  private reads = new Map<string, string>()
  private writes = new Map<string, Promise<NoteChatChange | null>>()
  constructor(private readonly service: NoteService = noteService) {}

  async list(root: string, query: string, relatedTo?: string) {
    const snapshot = await this.service.readSnapshot(root)
    if (relatedTo) await this.service.readNote(root, relatedTo)
    const relations = relatedTo ? snapshot.relations.filter(edge => edge.sourceUri === relatedTo || edge.targetUri === relatedTo) : []
    const mentions = relatedTo ? snapshot.mentions.filter(edge => edge.sourceUri === relatedTo || edge.targetUri === relatedTo) : []
    const related = new Set([relatedTo, ...relations.flatMap(edge => [edge.sourceUri, edge.targetUri]), ...mentions.flatMap(edge => [edge.sourceUri, edge.targetUri])])
    const search = query.trim().toLowerCase()
    return { repoId: snapshot.repoId, coverage: snapshot.coverage, relations, mentions, notes: snapshot.entries.filter(entry => entry.doc && (!relatedTo || related.has(entry.uri)) && (!search
      || [entry.doc.title, entry.doc.body, ...entry.doc.tags].join('\n').toLowerCase().includes(search)))
      .slice(0, 100).map(entry => ({ uri: entry.uri, title: entry.doc!.title, kind: entry.doc!.kind, path: entry.relPath })),
      diagnostics: snapshot.diagnostics }
  }

  async read(root: string, uri: string) {
    if (!NOTE_URI_RE.test(uri)) throw new Error('Invalid Note URI')
    await this.service.readSnapshot(root)
    const result = await this.service.readNote(root, uri)
    this.reads.set(`${root}:${uri}`, result.sha256)
    return { uri, markdown: result.raw, expectedHash: result.sha256, path: result.relPath, workspacePath: root }
  }

  async readPage(root: string, uri: string, options: { offset?: unknown; maxChars?: unknown } = {}) {
    const read = await this.read(root, uri)
    const offset = z.number().int().min(0).parse(options.offset ?? 0)
    const maxChars = z.number().int().min(500).max(12000).parse(options.maxChars ?? 6000)
    if (offset > read.markdown.length) throw new Error('Offset is beyond the Note source')
    return { ...read, title: /^#\s+(.+)$/m.exec(read.markdown)?.[1] ?? uri,
      markdown: read.markdown.slice(offset, offset + maxChars), offset, totalChars: read.markdown.length,
      ...(offset + maxChars < read.markdown.length ? { nextOffset: offset + maxChars, truncated: true } : {}) }
  }

  write(root: string, conversationId: string, callId: string, input: unknown, authorized: boolean, signal: AbortSignal): Promise<NoteChatChange | null> {
    const key = `${root}:${conversationId}:${callId}`
    const existing = this.writes.get(key)
    if (existing) return existing
    const writing = this.apply(root, conversationId, input, authorized, signal)
    this.writes.set(key, writing)
    return writing
  }

  private async apply(root: string, conversationId: string, input: unknown, authorized: boolean, signal: AbortSignal): Promise<NoteChatChange | null> {
    if (!authorized) throw new Error('This turn requests discussion only. Ask the user for a Note change instruction.')
    if (signal.aborted) throw new Error('Note edit cancelled')
    const args = writeSchema.parse(input)
    const snapshot = await this.service.readSnapshot(root)
    if (!snapshot.repoId) throw new Error('Project Note identity is missing')
    const files: NoteChatChange['files'] = []
    const ops: Parameters<NoteService['applyBundleChangeSet']>[1]['operations'] = []
    const seen = new Set<string>()
    for (const op of args.operations) {
      if (Object.keys(op.sections).some(name => !name.trim() || /[\r\n]/.test(name))) throw new Error('Invalid section name')
      let uri: string, before: string, after: string, expectedHash: string | null
      if (op.type === 'create') {
        if (!op.kind || !op.title || op.uri || op.expectedHash) throw new Error('Create requires kind and title; Note identity is host assigned')
        const created = createNoteOp(snapshot.repoId, op.kind, op.title, op.parent ?? null, args.reason)
        uri = created.uri; before = ''; expectedHash = null
        after = mergeNoteEdit(parseNote(created.afterMarkdown!), created.afterMarkdown!, { frontmatter: { tags: op.tags, lifecycle: op.lifecycle, work: op.work, relations: op.relations, codeRefs: op.codeRefs } as NoteEdit['frontmatter'], sections: op.sections }, args.reason)
      } else {
        if (!op.uri || !op.expectedHash || this.reads.get(`${root}:${op.uri}`) !== op.expectedHash) throw new Error('Read the Note with note_read before editing; use its exact expectedHash')
        const current = await this.service.readNote(root, op.uri)
        if (current.sha256 !== op.expectedHash) throw new Error('CONFLICT: Note changed since reading; read it again')
        if (current.note.meta.execution) throw new Error('Task has execution metadata; use the execution workflow to change its contract')
        if (op.kind && op.kind !== current.note.meta.kind) throw new Error('Note kind cannot be changed')
        uri = op.uri; before = current.raw; expectedHash = op.expectedHash
        after = mergeNoteEdit(current.note, before, { title: op.title, frontmatter: { tags: op.tags, parent: op.parent, lifecycle: op.lifecycle, work: op.work, relations: op.relations, codeRefs: op.codeRefs } as NoteEdit['frontmatter'], sections: op.sections }, args.reason)
      }
      if (seen.has(uri)) throw new Error('Duplicate Note in one write')
      seen.add(uri)
      if (before === after) continue
      files.push({ uri, title: /^#\s+(.+)$/m.exec(after)?.[1] ?? uri, before, after })
      ops.push({ operationId: randomUUID(), type: op.type === 'create' ? 'create' : 'replace', uri, expectedHash, afterMarkdown: after })
    }
    if (!ops.length) return null
    if (signal.aborted) throw new Error('Note edit cancelled')
    const change: NoteChatChange = { id: randomUUID(), conversationId, workspacePath: root, reason: args.reason, createdAt: new Date().toISOString(), files }
    await saveChange(change)
    if (signal.aborted) throw new Error('Note edit cancelled')
    const result = await this.service.applyBundleChangeSet(root, { id: change.id, revision: 1,
      source: { type: 'chat', id: conversationId, revision: 1 }, operations: ops }, args.reason)
    change.txId = result.txId
    // The committed transaction remains authoritative if saving the convenience reference fails.
    await saveChange(change).catch(() => undefined)
    return change
  }
}
