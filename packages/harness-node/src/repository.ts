/**
 * File-level note repository (contract C1/C5, storage half).
 * Scan, read, and atomic write under `<root>/.agents/notes`.
 * Parsing and validation stay in harness-core; this module owns bytes,
 * identity collisions, and symlink confinement. No process-wide state.
 * Note: derived graph queries stay in this scan boundary — see .agents/notes/2026-09-24-note-index-v1--4f6c2a91.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseNote, validateNote, type Diagnostic, type ParsedNote, type RelationType } from '@janus-agent/harness-core';
import { claimsHarnessSchema, readHarnessIdentity } from './profile.js';

export const NOTES_DIR = join('.agents', 'notes');
export const LOCAL_DIR = join('.agents', '.local');

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isWithin(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !resolve(p).startsWith(resolve(root) + '..');
}

export function toPosixRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/');
}

export interface ScannedFile {
  absPath: string;
  relPath: string;
}

/** Recursive `.md` scan. Escaping symlinks are skipped with a diagnostic, never followed. */
export async function listNoteFiles(root: string): Promise<{ files: ScannedFile[]; diagnostics: Diagnostic[] }> {
  const files: ScannedFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const base = resolve(root, NOTES_DIR);
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        try {
          const target = await realpath(full);
          if (!isWithin(resolve(root), target)) {
            diagnostics.push(diag('SCHEMA_INVALID', `symlink escapes root: ${toPosixRel(root, full)}`, full));
            continue;
          }
          const st = await lstat(target);
          if (st.isDirectory()) await walk(full);
          else if (full.endsWith('.md')) files.push({ absPath: full, relPath: toPosixRel(root, full) });
        } catch {
          diagnostics.push(diag('NOT_FOUND', `dangling symlink: ${toPosixRel(root, full)}`, full));
        }
        continue;
      }
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) files.push({ absPath: full, relPath: toPosixRel(root, full) });
    }
  };
  await walk(base);
  return { files, diagnostics };
}

export interface ReadNote {
  bytes: Uint8Array;
  sha256: string;
  text: string;
}

export async function readNoteFile(absPath: string): Promise<ReadNote> {
  const bytes = await readFile(absPath);
  return { bytes, sha256: sha256HexBytes(bytes), text: Buffer.from(bytes).toString('utf8') };
}

/** Same-directory temp file plus rename: crash leaves either old or new bytes. */
export async function writeFileAtomic(absPath: string, text: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = join(dirname(absPath), `.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, absPath);
}

export interface IndexEntry {
  relPath: string;
  sha256: string;
  note?: ParsedNote;
  diagnostics: Diagnostic[];
  foreign?: boolean;
}

export interface IndexedRelation {
  sourceUri: string;
  targetUri: string;
  type: RelationType;
  criteria?: string[];
  scope?: 'full' | 'partial';
  reason?: string;
}

export interface Backlink {
  sourceUri: string;
  type: RelationType;
  criteria?: string[];
  scope?: 'full' | 'partial';
  reason?: string;
}

export interface NoteIndex {
  repoId: string | null;
  entries: IndexEntry[];
  byId: Map<string, IndexEntry>;
  byUri: Map<string, IndexEntry>;
  /** Outgoing edges keyed by source URI; includes the parent edge. */
  outgoing: Map<string, IndexedRelation[]>;
  /** Incoming edges keyed by target URI; rebuilt from Note frontmatter. */
  backlinks: Map<string, Backlink[]>;
  /** All declared edges, including targets outside this repository. */
  relations: IndexedRelation[];
  diagnostics: Diagnostic[];
}

export interface NoteQuery {
  kind?: string;
  lifecycle?: string;
  tag?: string;
  relationType?: RelationType;
  codePath?: string;
  q?: string;
}

export interface NoteSearchHit {
  entry: IndexEntry;
  score: number;
  fields: Array<'title' | 'metadata' | 'body' | 'codeRef' | 'relation'>;
}

function searchableText(entry: IndexEntry): string {
  if (!entry.note) return '';
  const meta = entry.note.meta;
  const code = (meta.codeRefs ?? []).flatMap((ref) => [ref.path, ref.symbol ?? '', ref.role]);
  const relations = [
    ...(meta.parent ? [{ type: 'parent', target: meta.parent, criteria: [] as string[] }] : []),
    ...(meta.relations ?? []),
  ].flatMap((rel) => [rel.type, rel.target, ...(rel.criteria ?? [])]);
  return [entry.note.title, meta.id, meta.kind, meta.lifecycle, ...(meta.tags ?? []), ...code, ...relations, entry.note.body]
    .join('\n')
    .toLowerCase();
}

function matchesQuery(index: NoteIndex, entry: IndexEntry, query: NoteQuery): boolean {
  if (!entry.note || entry.diagnostics.length > 0) return false;
  const meta = entry.note.meta;
  if (query.kind && meta.kind !== query.kind) return false;
  if (query.lifecycle && meta.lifecycle !== query.lifecycle) return false;
  if (query.tag && !(meta.tags ?? []).includes(query.tag)) return false;
  if (query.codePath) {
    const needle = query.codePath.toLowerCase();
    if (!(meta.codeRefs ?? []).some((ref) => `${ref.path} ${ref.symbol ?? ''}`.toLowerCase().includes(needle))) return false;
  }
  if (query.relationType) {
    const uri = index.repoId ? noteUri(index.repoId, meta.id) : null;
    const hasOutgoing = uri ? (index.outgoing.get(uri) ?? []).some((rel) => rel.type === query.relationType) : false;
    const hasIncoming = uri ? (index.backlinks.get(uri) ?? []).some((rel) => rel.type === query.relationType) : false;
    if (!hasOutgoing && !hasIncoming) return false;
  }
  if (query.q && !searchableText(entry).includes(query.q.toLowerCase())) return false;
  return true;
}

/** Filter valid entries without changing the underlying scan result. */
export function queryNoteIndex(index: NoteIndex, query: NoteQuery = {}): IndexEntry[] {
  return index.entries.filter((entry) => matchesQuery(index, entry, query));
}

/** Small deterministic search helper; this is substring search, not a ranking engine. */
export function searchNoteIndex(index: NoteIndex, query: string, limit = 20, filters: NoteQuery = {}): NoteSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) return [];
  const hits: NoteSearchHit[] = [];
  for (const entry of index.entries) {
    if (!matchesQuery(index, entry, filters)) continue;
    const note = entry.note;
    if (!note) continue;
    const meta = note.meta;
    const fields: NoteSearchHit['fields'] = [];
    let score = 0;
    const title = note.title.toLowerCase();
    const metadata = [meta.id, meta.kind, meta.lifecycle, ...(meta.tags ?? [])].join(' ').toLowerCase();
    const body = note.body.toLowerCase();
    const code = (meta.codeRefs ?? []).map((ref) => `${ref.path} ${ref.symbol ?? ''}`).join(' ').toLowerCase();
    const relation = (index.outgoing.get(index.repoId ? noteUri(index.repoId, meta.id) : '') ?? [])
      .flatMap((rel) => [rel.type, rel.targetUri, ...(rel.criteria ?? [])])
      .join(' ')
      .toLowerCase();
    if (title.includes(needle)) { score += 8; fields.push('title'); }
    if (metadata.includes(needle)) { score += 4; fields.push('metadata'); }
    if (body.includes(needle)) { score += 2; fields.push('body'); }
    if (code.includes(needle)) { score += 5; fields.push('codeRef'); }
    if (relation.includes(needle)) { score += 3; fields.push('relation'); }
    if (score > 0) hits.push({ entry, score, fields });
  }
  return hits
    .sort((a, b) => b.score - a.score || compareText(a.entry.relPath, b.entry.relPath))
    .slice(0, limit);
}

/** Full-repo index. Invalid files diagnose in place; originals are never altered here. */
export async function buildNoteIndex(root: string): Promise<NoteIndex> {
  const diagnostics: Diagnostic[] = [];
  const { files, diagnostics: scanDiags } = await listNoteFiles(root);
  diagnostics.push(...scanDiags);
  const identity = await readHarnessIdentity(root);
  const repoId = identity.repoId;
  diagnostics.push(...identity.diagnostics);
  const entries: IndexEntry[] = [];
  for (const f of files) {
    let read: ReadNote;
    try {
      read = await readNoteFile(f.absPath);
    } catch {
      const entry: IndexEntry = { relPath: f.relPath, sha256: '', diagnostics: [diag('IO_ERROR', `unreadable: ${f.relPath}`, f.relPath)] };
      entries.push(entry);
      continue;
    }
    if (!claimsHarnessSchema(read.text)) {
      entries.push({ relPath: f.relPath, sha256: read.sha256, diagnostics: [], foreign: true });
      continue;
    }
    try {
      const note = parseNote(read.text);
      entries.push({ relPath: f.relPath, sha256: read.sha256, note, diagnostics: validateNote(note) });
    } catch (e) {
      const code = (e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID';
      entries.push({ relPath: f.relPath, sha256: read.sha256, diagnostics: [diag(code, (e as Error).message, f.relPath)] });
    }
  }
  const byId = new Map<string, IndexEntry>();
  const byUri = new Map<string, IndexEntry>();
  const outgoing = new Map<string, IndexedRelation[]>();
  const backlinks = new Map<string, Backlink[]>();
  const relations: IndexedRelation[] = [];
  const lowerPaths = new Map<string, string>();
  for (const e of entries) {
    const lower = e.relPath.toLowerCase();
    const clash = lowerPaths.get(lower);
    if (clash !== undefined && clash !== e.relPath) {
      diagnostics.push(diag('SCHEMA_INVALID', `case-colliding paths: ${clash} vs ${e.relPath}`, e.relPath));
    } else lowerPaths.set(lower, e.relPath);
    if (!e.note) continue;
    const prev = byId.get(e.note.meta.id);
    if (prev) {
      diagnostics.push(diag('SCHEMA_INVALID', `duplicate note id ${e.note.meta.id}: ${prev.relPath} vs ${e.relPath}`, e.relPath));
    }
    else byId.set(e.note.meta.id, e);
    if (!repoId || prev || e.diagnostics.length > 0) continue;
    const sourceUri = noteUri(repoId, e.note.meta.id);
    byUri.set(sourceUri, e);

    const addRelation = (relation: { type: RelationType; target: string; criteria?: string[]; scope?: 'full' | 'partial'; reason?: string }): void => {
      const edge: IndexedRelation = {
        sourceUri,
        targetUri: relation.target,
        type: relation.type,
        ...(relation.criteria ? { criteria: [...relation.criteria] } : {}),
        ...(relation.scope ? { scope: relation.scope } : {}),
        ...(relation.reason ? { reason: relation.reason } : {}),
      };
      relations.push(edge);
      const outgoingEdges = outgoing.get(sourceUri) ?? [];
      outgoingEdges.push(edge);
      outgoing.set(sourceUri, outgoingEdges);
      const incoming = backlinks.get(edge.targetUri) ?? [];
      incoming.push({
        sourceUri,
        type: edge.type,
        ...(edge.criteria ? { criteria: edge.criteria } : {}),
        ...(edge.scope ? { scope: edge.scope } : {}),
        ...(edge.reason ? { reason: edge.reason } : {}),
      });
      backlinks.set(edge.targetUri, incoming);
    };

    if (e.note.meta.parent) addRelation({ type: 'parent', target: e.note.meta.parent });
    for (const relation of e.note.meta.relations ?? []) addRelation(relation);
  }
  for (const incoming of backlinks.values()) incoming.sort((a, b) => compareText(a.sourceUri, b.sourceUri) || compareText(a.type, b.type));
  for (const edges of outgoing.values()) edges.sort((a, b) => compareText(a.targetUri, b.targetUri) || compareText(a.type, b.type));
  relations.sort((a, b) => compareText(a.sourceUri, b.sourceUri) || compareText(a.targetUri, b.targetUri) || compareText(a.type, b.type));
  return { repoId, entries, byId, byUri, outgoing, backlinks, relations, diagnostics };
}

export function noteUri(repoId: string, noteId: string): string {
  return `note://${repoId}/${noteId}`;
}

/** Create-time filename: first-date, readable slug, >=8 id prefix (C1). */
export function noteFileName(created: string, title: string, id: string, taken: Set<string>): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'note';
  let prefix = id.slice(0, 8);
  let name = `${created}-${slug}--${prefix}.md`;
  while (taken.has(name.toLowerCase())) {
    prefix = id.slice(0, prefix.length + 1);
    name = `${created}-${slug}--${prefix}.md`;
  }
  taken.add(name.toLowerCase());
  return name;
}
