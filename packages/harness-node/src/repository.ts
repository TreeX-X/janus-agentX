/**
 * File-level note repository (contract C1/C5, storage half).
 * Scan, read, and atomic write under `<root>/.agents/notes`.
 * Parsing and validation stay in harness-core; this module owns bytes,
 * identity collisions, and symlink confinement. No process-wide state.
 * Note: derived graph queries stay in this scan boundary — see .agents/notes/2026-09-24-note-index-v1--4f6c2a91.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkAcyclic, parseNote, readMarkdownView, validateNote, type Diagnostic, type MarkdownView, type ParsedNote, type RelationType } from '@janus-agent/harness-core';
import { claimsHarnessSchema, readHarnessIdentity } from './profile.js';
import { deriveMentions, resolveNoteReference, type IndexedMention, type NoteResolution } from './references.js';

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
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function toPosixRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/');
}

export interface ScannedFile {
  absPath: string;
  relPath: string;
}

/** Recursive `.md` scan. Escaping symlinks are skipped with a diagnostic, never followed. */
export async function listNoteFiles(root: string): Promise<{ files: ScannedFile[]; diagnostics: Diagnostic[]; complete: boolean }> {
  const files: ScannedFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const base = resolve(root, NOTES_DIR);
  let realRoot: string;
  try { realRoot = await realpath(root); } catch {
    return { files, diagnostics: [diag('IO_ERROR', 'checkout unreadable', resolve(root))], complete: false };
  }
  // No Notes directory is an empty corpus; an unreadable/dangling one is not.
  try { await lstat(base); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files, diagnostics, complete: true };
    return { files, diagnostics: [diag('IO_ERROR', 'notes directory unreadable', base)], complete: false };
  }
  const walk = async (dir: string, ancestors: Set<string>): Promise<void> => {
    try {
      const actual = await realpath(dir);
      if (!isWithin(realRoot, actual) || ancestors.has(actual)) {
        diagnostics.push(diag('SCHEMA_INVALID', `directory escapes checkout or cycles: ${toPosixRel(root, dir)}`, dir));
        return;
      }
      const branch = new Set(ancestors).add(actual);
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => compareText(a.name, b.name));
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isSymbolicLink()) {
          try {
            const target = await realpath(full);
            if (!isWithin(realRoot, target)) {
              diagnostics.push(diag('SCHEMA_INVALID', `symlink escapes root: ${toPosixRel(root, full)}`, full));
              continue;
            }
            const st = await lstat(target);
            if (st.isDirectory()) await walk(full, branch);
            else if (st.isFile() && full.toLowerCase().endsWith('.md')) files.push({ absPath: full, relPath: toPosixRel(root, full) });
          } catch {
            diagnostics.push(diag('IO_ERROR', `symlink unreadable: ${toPosixRel(root, full)}`, full));
          }
          continue;
        }
        if (e.isDirectory()) await walk(full, branch);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) files.push({ absPath: full, relPath: toPosixRel(root, full) });
      }
    } catch {
      diagnostics.push(diag('IO_ERROR', `directory unreadable: ${toPosixRel(root, dir)}`, dir));
    }
  };
  await walk(base, new Set());
  files.sort((a, b) => compareText(a.relPath, b.relPath));
  return { files, diagnostics, complete: diagnostics.length === 0 };
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
  /** Raw bytes from the same read as note/view. Null only when unreadable. */
  sourceHash: string | null;
  classification: 'valid' | 'legacy' | 'foreign' | 'malformed' | 'conflicting-identity' | 'unreadable';
  note?: ParsedNote;
  view?: MarkdownView;
  diagnostics: Diagnostic[];
  foreign?: boolean;
}

export interface IndexedRelation {
  sourceUri: string;
  targetUri: string;
  type: RelationType;
  declarations: string[];
  resolution: NoteResolution;
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
  byPath: Map<string, IndexEntry>;
  /** Every member is retained; no winner is published in byId/byUri. */
  conflicts: Map<string, IndexEntry[]>;
  coverage: NoteCoverage;
  /** Outgoing edges keyed by source URI; includes the parent edge. */
  outgoing: Map<string, IndexedRelation[]>;
  /** Incoming edges keyed by target URI; rebuilt from Note frontmatter. */
  backlinks: Map<string, Backlink[]>;
  /** All declared edges, including targets outside this repository. */
  relations: IndexedRelation[];
  mentions: IndexedMention[];
  /** Declared mentions from this checkout; inspect resolution before navigation. */
  mentionBacklinks: Map<string, IndexedMention[]>;
  /** Navigation/locator diagnostics never gate managed mutations. */
  readDiagnostics: Diagnostic[];
  diagnostics: Diagnostic[];
}

export interface NoteCoverage {
  checkoutRoot: string;
  status: 'complete' | 'incomplete';
  /** Deterministic manifest hash, not a sourceHash or an atomic filesystem snapshot. */
  snapshotHash: string;
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
  const { files, diagnostics: scanDiags, complete } = await listNoteFiles(root);
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
      const entry: IndexEntry = { relPath: f.relPath, sha256: '', sourceHash: null, classification: 'unreadable', diagnostics: [diag('IO_ERROR', `unreadable: ${f.relPath}`, f.relPath)] };
      entries.push(entry);
      diagnostics.push(...entry.diagnostics);
      continue;
    }
    if (!claimsHarnessSchema(read.text)) {
      const view = readMarkdownView(read.text);
      const classification = view.headings.find((heading) => heading.depth === 1)?.text.startsWith('Agent Note:') ? 'legacy' : 'foreign';
      entries.push({ relPath: f.relPath, sha256: read.sha256, sourceHash: read.sha256, classification, view, diagnostics: [], foreign: true });
      continue;
    }
    try {
      const note = parseNote(read.text);
      const problems = validateNote(note);
      entries.push({ relPath: f.relPath, sha256: read.sha256, sourceHash: read.sha256, classification: problems.length ? 'malformed' : 'valid', note, view: readMarkdownView(note.body), diagnostics: problems });
    } catch (e) {
      const code = (e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID';
      entries.push({ relPath: f.relPath, sha256: read.sha256, sourceHash: read.sha256, classification: 'malformed', diagnostics: [diag(code, (e as Error).message, f.relPath)] });
    }
  }
  const byId = new Map<string, IndexEntry>();
  const byUri = new Map<string, IndexEntry>();
  const byPath = new Map(entries.map((entry) => [entry.relPath, entry]));
  const conflicts = new Map<string, IndexEntry[]>();
  const idGroups = new Map<string, IndexEntry[]>();
  const pathGroups = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const pathKey = entry.relPath.toLowerCase();
    pathGroups.set(pathKey, [...(pathGroups.get(pathKey) ?? []), entry]);
    if (entry.note) {
      const id = entry.note.meta.id;
      idGroups.set(id, [...(idGroups.get(id) ?? []), entry]);
    }
  }
  const markConflict = (group: IndexEntry[], message: string): void => {
    for (const entry of group) {
      const problem = diag('SCHEMA_INVALID', message, entry.relPath);
      entry.classification = 'conflicting-identity';
      entry.diagnostics.push(problem);
      diagnostics.push(problem);
    }
  };
  for (const group of pathGroups.values()) {
    if (group.length > 1) markConflict(group, `case-colliding paths: ${group.map((e) => e.relPath).join(', ')}`);
  }
  for (const [id, group] of idGroups) {
    if (group.length > 1) markConflict(group, `duplicate note id ${id}: ${group.map((e) => e.relPath).join(', ')}`);
    if (group.some((entry) => entry.classification === 'conflicting-identity')) {
      conflicts.set(id, group);
      continue;
    }
    const entry = group[0];
    byId.set(id, entry); // Unique invalid records remain available to write validation.
    if (repoId && entry.diagnostics.length === 0) byUri.set(noteUri(repoId, id), entry);
  }
  const outgoing = new Map<string, IndexedRelation[]>();
  const backlinks = new Map<string, Backlink[]>();
  const relations: IndexedRelation[] = [];
  const coverageDiagnostics = [...scanDiags, ...entries.filter((entry) => entry.classification === 'unreadable').flatMap((entry) => entry.diagnostics)];
  const coverage: NoteCoverage = {
    checkoutRoot: resolve(root),
    status: complete && coverageDiagnostics.length === 0 ? 'complete' : 'incomplete',
    snapshotHash: sha256HexBytes(Buffer.from(JSON.stringify([resolve(root), repoId, identity.diagnostics, entries.map((entry) => [entry.relPath, entry.sourceHash, entry.classification]), coverageDiagnostics]))),
    diagnostics: coverageDiagnostics,
  };
  const index: NoteIndex = { repoId, entries, byId, byUri, byPath, conflicts, coverage, outgoing, backlinks, relations, mentions: [], mentionBacklinks: new Map(), readDiagnostics: [], diagnostics };
  for (const [sourceUri, e] of byUri) {
    const addRelation = (relation: { type: RelationType; target: string; criteria?: string[]; scope?: 'full' | 'partial'; reason?: string }, declaration: string): void => {
      const existing = (outgoing.get(sourceUri) ?? []).find((edge) => edge.type === relation.type && edge.targetUri === relation.target &&
        JSON.stringify(edge.criteria) === JSON.stringify(relation.criteria) && edge.scope === relation.scope && edge.reason === relation.reason);
      if (existing) { existing.declarations.push(declaration); return; }
      const edge: IndexedRelation = {
        sourceUri,
        targetUri: relation.target,
        type: relation.type,
        declarations: [declaration],
        resolution: resolveNoteReference(index, relation.target),
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

    const meta = e.note!.meta;
    if (meta.parent) addRelation({ type: 'parent', target: meta.parent }, 'parent');
    for (const [position, relation] of (meta.relations ?? []).entries()) addRelation(relation, `relations[${position}]`);
  }
  for (const incoming of backlinks.values()) incoming.sort((a, b) => compareText(a.sourceUri, b.sourceUri) || compareText(a.type, b.type));
  for (const edges of outgoing.values()) edges.sort((a, b) => compareText(a.targetUri, b.targetUri) || compareText(a.type, b.type));
  relations.sort((a, b) => compareText(a.sourceUri, b.sourceUri) || compareText(a.targetUri, b.targetUri) || compareText(a.type, b.type));
  index.mentions = deriveMentions(index);
  for (const mention of index.mentions) {
    if (!mention.targetUri || mention.resolution.status === 'invalid' || mention.resolution.status === 'ambiguous') continue;
    const incoming = index.mentionBacklinks.get(mention.targetUri) ?? [];
    incoming.push(mention);
    index.mentionBacklinks.set(mention.targetUri, incoming);
  }
  index.readDiagnostics = [
    ...checkAcyclic([...byUri].map(([uri, entry]) => ({ uri, note: entry.note! }))),
    ...relations.flatMap((edge) => edge.resolution.diagnostics.map((problem) => ({ ...problem, path: edge.sourceUri }))),
    ...index.mentions.flatMap((mention) => mention.resolution.diagnostics.map((problem) => ({ ...problem, path: mention.sourceUri }))),
  ];
  return index;
}

/** Re-read only an indexed path in its selected checkout. Fresh bytes own the hash. */
export async function readIndexedNote(index: NoteIndex, relPath: string): Promise<
  | { ok: true; text: string; sha256: string; sourceHash: string; indexedSourceHash: string | null; matchesSnapshot: boolean }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const entry = index.byPath.get(relPath);
  if (!entry) return { ok: false, diagnostics: [diag('NOT_FOUND', 'path is outside the indexed corpus', relPath)] };
  try {
    const root = await realpath(index.coverage.checkoutRoot);
    const path = await realpath(resolve(index.coverage.checkoutRoot, relPath));
    if (!isWithin(root, path)) return { ok: false, diagnostics: [diag('PERMISSION_DENIED', 'source escapes selected checkout', relPath)] };
    const read = await readNoteFile(path);
    return { ok: true, text: read.text, sha256: read.sha256, sourceHash: read.sha256, indexedSourceHash: entry.sourceHash, matchesSnapshot: read.sha256 === entry.sourceHash };
  } catch {
    return { ok: false, diagnostics: [diag('IO_ERROR', 'indexed source is no longer readable; rebuild before inferring deletion', relPath)] };
  }
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
