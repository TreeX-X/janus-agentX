/**
 * File-level note repository (contract C1/C5, storage half).
 * Scan, read, and atomic write under `<root>/.agents/notes`.
 * Parsing and validation stay in harness-core; this module owns bytes,
 * identity collisions, and symlink confinement. No process-wide state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseNote, validateNote, type Diagnostic, type ParsedNote } from '@janus-agent/harness-core';

export const NOTES_DIR = join('.agents', 'notes');
export const LOCAL_DIR = join('.agents', '.local');

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
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
}

export interface NoteIndex {
  repoId: string | null;
  entries: IndexEntry[];
  byId: Map<string, IndexEntry>;
  diagnostics: Diagnostic[];
}

/** Full-repo index. Invalid files diagnose in place; originals are never altered here. */
export async function buildNoteIndex(root: string): Promise<NoteIndex> {
  const diagnostics: Diagnostic[] = [];
  const { files, diagnostics: scanDiags } = await listNoteFiles(root);
  diagnostics.push(...scanDiags);
  let repoId: string | null = null;
  try {
    const harnessRaw = await readFile(resolve(root, '.agents', 'harness.json'), 'utf8');
    const harness = JSON.parse(harnessRaw) as { repoId?: unknown };
    if (typeof harness.repoId === 'string') repoId = harness.repoId;
  } catch {
    repoId = null;
  }
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
    try {
      const note = parseNote(read.text);
      entries.push({ relPath: f.relPath, sha256: read.sha256, note, diagnostics: validateNote(note) });
    } catch (e) {
      const code = (e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID';
      entries.push({ relPath: f.relPath, sha256: read.sha256, diagnostics: [diag(code, (e as Error).message, f.relPath)] });
    }
  }
  const byId = new Map<string, IndexEntry>();
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
    } else byId.set(e.note.meta.id, e);
  }
  return { repoId, entries, byId, diagnostics };
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
