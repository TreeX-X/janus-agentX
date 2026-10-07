// Note: shared engineering capabilities and host extensions — see .agents/notes/harness/storage/history/workflowx-runtime.md
import { randomUUID } from 'node:crypto'
import {
  parseNote,
  serializeNote,
  splitFrontmatter,
  validateNote,
  type ParsedNote,
} from './index.js'
import type { NoteKind } from './schema.js'

export const KIND_SECTIONS: Record<NoteKind, string[]> = {
  module: ['Responsibility', 'Design'], note: ['Description'],
  idea: ['Background', 'Idea', 'Open questions'],
  initiative: ['Goal', 'Scope', 'Acceptance criteria'],
  requirement: ['Problem', 'Expected behavior', 'Scope', 'Acceptance criteria'],
  decision: ['Problem', 'Proposal', 'Alternatives considered', 'Risks'],
  task: ['Scope', 'Acceptance criteria', 'Verification'],
}

export interface NoteEdit {
  title?: string
  sections: Record<string, string>
  frontmatter: { kind?: NoteKind; module?: string; moduleState?: ParsedNote['meta']['moduleState']; role?: 'project'; tags?: string[]; parent?: string | null; lifecycle?: string; work?: ParsedNote['meta']['work']; relations?: ParsedNote['meta']['relations']; codeRefs?: ParsedNote['meta']['codeRefs'] }
}

export interface ProducedOp {
  operationId: string
  type: 'create' | 'replace' | 'delete'
  uri: string
  expectedHash: string | null
  relativePath?: string
  afterMarkdown?: string
  dependsOn: string[]
  reason: string
  evidenceRefs: string[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function frontmatter(lines: Record<string, string | string[] | undefined>): string {
  const out: string[] = []
  for (const [key, value] of Object.entries(lines)) {
    if (value === undefined) continue
    if (Array.isArray(value)) out.push(`${key}: [${value.join(', ')}]`)
    else out.push(`${key}: ${value}`)
  }
  return out.join('\n')
}

/** Fresh draft skeletons; the editor fills sections through replace ops. */
export function createNoteInput(kind: NoteKind, title: string, parentUri: string | null, options: { schema?: 'harness-note/1' | 'harness-note/2'; module?: string; moduleState?: ParsedNote['meta']['moduleState']; role?: 'project'; work?: ParsedNote['meta']['work'];
  sections?: Record<string, string>; lifecycle?: string; class?: ParsedNote['meta']['class']; tags?: string[]
} = {}): { id: string; markdown: string } {
  const id = randomUUID()
  if (options.schema === 'harness-note/2') {
    if (kind === 'initiative') throw new Error('UNSUPPORTED_SCHEMA: v2 uses module instead of initiative');
    const now = new Date().toISOString();
    const defaults: Record<string, string[]> = {module: ['Responsibility','Design'], note: ['Description'], idea: ['Intent'], requirement: ['Expected behavior','Acceptance criteria'], decision: ['Problem','Decision','Alternatives considered','Consequences'], task: ['Scope','Acceptance criteria','Verification','Progress','Evidence','Handoff']};
    const meta = {schema: 'harness-note/2', id, kind, lifecycle: options.lifecycle ?? 'draft', created: now.slice(0,10), updated: now,
      ...(kind === 'module' ? {moduleState: options.moduleState ?? 'planned', ...(parentUri ? {parent: parentUri} : {role: options.role ?? 'project'})} : {module: options.module ?? parentUri}),
      ...(options.tags ? {tags: options.tags} : {}), ...(options.work ? {work: options.work} : {})};
    const sections = options.sections ?? Object.fromEntries(defaults[kind].map(name => [name, 'Pending definition.']));
    return {id, markdown: '---\n'+JSON.stringify(meta,null,2)+'\n---\n\n# '+title+'\n\n'+Object.entries(sections).map(([name,text])=>'## '+name+'\n\n'+text).join('\n\n')+'\n'};
  }
  const sections = KIND_SECTIONS[kind].map((name) => `## ${name}\n\n${name === 'Open questions' ? 'None.' : 'TBD.'}`).join('\n\n')
  const fm: Record<string, string | string[] | undefined> = {
    schema: 'harness-note/1',
    id,
    kind,
    lifecycle: 'draft',
    created: today(),
  }
  if (parentUri) fm['parent'] = parentUri
  const note = parseNote(`---\n${frontmatter(fm)}\n---\n\n# ${title}\n\n${sections}\n`)
  if (options.sections) note.body = `\n# ${title}\n\n${Object.entries(options.sections).map(([name, text]) => `## ${name}\n\n${text}`).join('\n\n')}\n`
  if (options.lifecycle) note.meta.lifecycle = options.lifecycle as ParsedNote['meta']['lifecycle']
  if (options.class) note.meta.class = options.class
  if (options.tags) note.meta.tags = options.tags
  return { id, markdown: serializeNote(note) }
}

export function createNoteOp(repoId: string, kind: NoteKind, title: string, parentUri: string | null, reason: string): ProducedOp & { noteId: string } {
  const { id, markdown } = createNoteInput(kind, title, parentUri)
  return {
    operationId: `create-${id.slice(0, 8)}`,
    type: 'create',
    uri: `note://${repoId}/${id}`,
    expectedHash: null,
    afterMarkdown: markdown,
    dependsOn: [],
    reason,
    evidenceRefs: [],
    noteId: id,
  }
}

/** Line-based section replace used by the service merger (hash-stable slicing). */
export function setSection(body: string, name: string, text: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let cur: string | null = null
  let buf: string[] = []
  let fence = false
  const flush = (): void => {
    if (cur === null) return
    if (cur === name) out.push(`## ${name}`, '', text, '')
    else out.push(`## ${cur}`, '', ...buf)
    cur = null
    buf = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      if (cur !== null) buf.push(line)
      else out.push(line)
      continue
    }
    if (!fence) {
      const h2 = /^##\s+(.+)$/.exec(line)
      if (h2) {
        flush()
        cur = h2[1].trim()
        continue
      }
      if (/^#\s+/.test(line)) {
        flush()
        out.push(line, '')
        continue
      }
    }
    if (cur !== null) buf.push(line)
    else out.push(line)
  }
  flush()
  if (!body.split('\n').some((l) => /^##\s+/.test(l) && l.trim() === `## ${name}`)) {
    out.push(`## ${name}`, '', text, '')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Merge a structured edit onto parsed note bytes (frontmatter via data, prose via slices). */
export function mergeNoteEdit(note: ParsedNote, rawText: string, edit: NoteEdit, reason?: string): string {
  const meta = { ...(note.meta as unknown as Record<string, unknown>) } as Record<string, unknown> & ParsedNote['meta']
  if (edit.frontmatter.tags !== undefined) meta.tags = [...edit.frontmatter.tags]
  if (edit.frontmatter.work !== undefined) meta.work = structuredClone(edit.frontmatter.work)
  if (edit.frontmatter.relations !== undefined) meta.relations = structuredClone(edit.frontmatter.relations)
  if (edit.frontmatter.codeRefs !== undefined) meta.codeRefs = structuredClone(edit.frontmatter.codeRefs)
  if (edit.frontmatter.parent !== undefined) {
    if (edit.frontmatter.parent === null) delete (meta as Record<string, unknown>)['parent']
    else meta.parent = edit.frontmatter.parent
  }
  if (edit.frontmatter.lifecycle !== undefined) {
    meta.lifecycle = edit.frontmatter.lifecycle as ParsedNote['meta']['lifecycle']
    if ((edit.frontmatter.lifecycle === 'archived' || edit.frontmatter.lifecycle === 'rejected') && meta.disposition === undefined) {
      meta.disposition = { reason: reason ?? 'updated through the Note service' }
    }
    if (edit.frontmatter.lifecycle !== 'archived' && edit.frontmatter.lifecycle !== 'rejected') {
      delete (meta as Record<string, unknown>)['disposition']
    }
  }
  let body = splitFrontmatter(rawText).body
  if (edit.title !== undefined) {
    body = body.replace(/^#\s+.*$/m, `# ${edit.title}`)
    if (!/^#\s+/m.test(body)) body = `# ${edit.title}\n\n${body}`
  }
  for (const [name, text] of Object.entries(edit.sections)) {
    body = setSection(body, name, text)
  }
  for (const key of ['kind','module','moduleState','role'] as const) if (edit.frontmatter[key] !== undefined) (meta as Record<string, unknown>)[key] = edit.frontmatter[key];
  if (note.meta.schema === 'harness-note/2' && (JSON.stringify(meta) !== JSON.stringify(note.meta) || body !== splitFrontmatter(rawText).body)) meta.updated = new Date().toISOString();
  const merged: ParsedNote = { ...note, meta: meta as ParsedNote['meta'], body }
  const out = serializeNote(merged)
  // Round-trip guard: the merger must never produce an invalid note.
  const reparsed = parseNote(out)
  const problems = validateNote(reparsed)
  if (problems.length > 0) {
    throw { code: 'SCHEMA_INVALID', message: problems[0].message, path: problems[0].path }
  }
  return out
}

/** Archive-by-default delete (C2): true removal needs explicit destructive scope (later). */
export function archiveNoteOp(
  uri: string,
  expectedHash: string,
  afterMarkdown: string,
  reason: string,
): ProducedOp {
  return {
    operationId: `archive-${uri.split('/').pop()?.slice(0, 8) ?? 'note'}`,
    type: 'replace',
    uri,
    expectedHash,
    afterMarkdown,
    dependsOn: [],
    reason,
    evidenceRefs: [],
  }
}
