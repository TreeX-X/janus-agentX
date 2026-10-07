/**
 * notes-cli command functions (contract C5, surface half).
 * Pure against an explicit root: no process.cwd, no console, no exit.
 * Every result carries `{ok, data?, errors[]}`; `exitFor` maps to the
 * fixed CLI codes 0/2/3/4/5/6. `cli.ts` only parses argv and prints.
 * Note: shared read scope and snapshots — .agents/notes/harness/storage/history/note-index-v1.md
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkAcyclic,
  parseNote,
  validateNote,
  createNoteInput,
  type Diagnostic,
  type ParsedNote,
} from '@janus-agent/harness-core';
import {
  applyChangeSet,
  buildNoteIndex,
  noteUri,
  queryNoteIndex,
  readIndexedNote,
  readTaskResult,
  resolveNoteReference,
  searchNoteIndex,
  sha256HexBytes,
  type ApplyOpts,
  type NoteCoverage,
  type TaskResult,
} from '@janus-agent/harness-node';

export interface CliResult<T = unknown> {
  ok: boolean;
  data?: T;
  errors: Diagnostic[];
}

export async function cmdResult(root: string, ref: string, closeout = false): Promise<CliResult<TaskResult>> {
  const data = await readTaskResult(root, ref, { closeout });
  return { ok: data.errors.length === 0, data, errors: data.errors };
}

/** Fixed codes: 0 ok, 2 input, 3 conflict, 4 auth, 5 io/recovery, 6 capability. */
export function exitFor(errors: Diagnostic[]): number {
  if (errors.length === 0) return 0;
  const codes = new Set(errors.map((e) => e.code));
  if (codes.has('IO_ERROR') || codes.has('RECOVERY_REQUIRED') || codes.has('BUSY')) return 5;
  if (codes.has('APPROVAL_REQUIRED') || codes.has('PERMISSION_DENIED')) return 4;
  if (codes.has('CONFLICT') || codes.has('STALE_BASELINE') || codes.has('DEPENDENCY_UNSATISFIED')) return 3;
  if (codes.has('CAPABILITY_UNAVAILABLE')) return 6;
  return 2;
}

export interface NoteSummary {
  module?: string; parent?: string; moduleState?: string; updated?: string;
  id: string;
  uri: string | null;
  title: string;
  kind: string;
  lifecycle: string;
  relPath: string;
  excerpt: string;
  outgoing: number;
  incoming: number;
  sourceHash: string;
  mentions: number;
  mentionedBy: number;
}

function summarize(index: Awaited<ReturnType<typeof buildNoteIndex>>, entry: import('@janus-agent/harness-node').IndexEntry): NoteSummary {
  const note = entry.note!;
  const uri = index.repoId ? noteUri(index.repoId, note.meta.id) : null;
  return {
    id: note.meta.id,
    uri,
    title: note.title,
    kind: note.meta.kind,
    lifecycle: note.meta.lifecycle,
    module: note.meta.module, parent: note.meta.parent, moduleState: note.meta.moduleState, updated: note.meta.updated,
    relPath: entry.relPath,
    excerpt: entry.view?.excerpt ?? '',
    outgoing: uri ? (index.outgoing.get(uri)?.length ?? 0) : 0,
    incoming: uri ? (index.backlinks.get(uri)?.length ?? 0) : 0,
    sourceHash: entry.sourceHash!,
    mentions: uri ? index.mentions.filter((mention) => mention.sourceUri === uri).length : 0,
    mentionedBy: uri ? (index.mentionBacklinks.get(uri)?.length ?? 0) : 0,
  };
}

export interface NoteListResult {
  notes: NoteSummary[];
  coverage: NoteCoverage;
  excluded: CheckRow[];
  readDiagnostics: Diagnostic[];
  limit: number | null;
  truncated: boolean;
}

function readContext(index: Awaited<ReturnType<typeof buildNoteIndex>>) {
  return {
    coverage: index.coverage,
    excluded: index.entries.filter((entry) => entry.classification !== 'valid').map(checkRow),
    readDiagnostics: [...index.diagnostics, ...index.readDiagnostics],
  };
}

export async function cmdList(
  root: string,
  filters: { kind?: string; lifecycle?: string; tag?: string; relationType?: import('@janus-agent/harness-core').RelationType; codePath?: string; q?: string } = {},
): Promise<CliResult<NoteListResult>> {
  const index = await buildNoteIndex(root);
  const notes = queryNoteIndex(index, filters).map((entry) => summarize(index, entry));
  notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { ok: true, data: { notes, ...readContext(index), limit: null, truncated: false }, errors: [] };
}

export async function cmdSearch(
  root: string,
  query: string,
  options: { kind?: string; lifecycle?: string; tag?: string; limit?: number } = {},
): Promise<CliResult<NoteListResult>> {
  const index = await buildNoteIndex(root);
  // Apply metadata filters inside the search pass so the limit is counted
  // only against eligible notes.
  const limit = options.limit ?? 20;
  const hits = searchNoteIndex(index, query, limit + 1, options);
  const notes = hits.slice(0, limit).map((hit) => summarize(index, hit.entry));
  return { ok: true, data: { notes, ...readContext(index), limit, truncated: hits.length > limit }, errors: [] };
}

export async function cmdShow(root: string, ref: string): Promise<CliResult<{ text: string; sha256: string; sourceHash: string; indexedSourceHash: string | null; matchesSnapshot: boolean; summary: NoteSummary; coverage: NoteCoverage }>> {
  const index = await buildNoteIndex(root);
  let entry;
  if (ref.includes('://') || ref.startsWith('note:')) {
    const resolution = resolveNoteReference(index, ref);
    if (resolution.status !== 'resolved') return { ok: false, errors: resolution.diagnostics };
    entry = index.byUri.get(ref);
  } else {
    if (index.conflicts.has(ref)) return { ok: false, errors: [{ code: 'CONFLICT', message: `ambiguous Note identity: ${ref}` }] };
    entry = index.byId.get(ref) ?? index.byPath.get(ref);
    if (!entry) {
      const matches = index.entries.filter((e) => e.relPath.endsWith(`/${ref}`));
      if (matches.length > 1) return { ok: false, errors: [{ code: 'CONFLICT', message: `ambiguous Note path: ${ref}` }] };
      entry = matches[0];
    }
  }
  if (!entry) {
    if (index.coverage.status === 'incomplete' || !index.repoId) {
      return { ok: false, errors: [{ code: 'NOT_READY', message: `note unavailable in incomplete or unbound scan: ${ref}` }] };
    }
    return { ok: false, errors: [{ code: 'NOT_FOUND', message: `unknown note: ${ref}` }] };
  }
  if (entry.diagnostics.length) return { ok: false, errors: entry.diagnostics };
  if (!entry.note) return { ok: false, errors: [{ code: 'SCHEMA_INVALID', message: 'unmanaged Markdown has no Note identity; read its source file' }] };
  const source = await readIndexedNote(index, entry.relPath);
  if (!source.ok) return { ok: false, errors: source.diagnostics };
  return {
    ok: true,
    data: {
      text: source.text,
      sha256: source.sha256,
      sourceHash: source.sourceHash,
      indexedSourceHash: source.indexedSourceHash,
      matchesSnapshot: source.matchesSnapshot,
      summary: summarize(index, entry),
      coverage: index.coverage,
    },
    errors: [],
  };
}

export interface CreateInput {
  kind: ParsedNote['meta']['kind'];
  title: string;
  sections: Record<string, string>;
  lifecycle?: string;
  class?: ParsedNote['meta']['class'];
  tags?: string[];
  module?: string;
  moduleState?: ParsedNote['meta']['moduleState'];
  parent?: string;
  work?: ParsedNote['meta']['work'];
  relativePath?: string;
}

export async function cmdCreate(root: string, input: CreateInput): Promise<CliResult<{ relPath: string; id: string; uri: string | null }>> {
  const bound = await buildNoteIndex(root);
  if (!bound.repoId) {
    return { ok: false, errors: [{ code: 'NOT_READY', message: 'init .agents/harness.json with a repoId first' }] };
  }
  const { id, markdown: afterMarkdown } = createNoteInput(input.kind, input.title, input.parent ?? null, {...input, ...(bound.entries.some(e=>e.note?.meta.schema === 'harness-note/2') ? {schema:'harness-note/2' as const} : {})});
  let note: ParsedNote;
  try {
    note = parseNote(afterMarkdown);
  } catch (e) {
    return { ok: false, errors: [{ code: 'SCHEMA_INVALID', message: (e as Error).message }] };
  }
  const diags = validateNote(note);
  if (diags.length > 0) return { ok: false, errors: diags };
  const requestDigest = sha256HexBytes(Buffer.from(afterMarkdown, 'utf8'));
  const report = await applyChangeSet(
    root,
    {
      id: randomUUID(),
      revision: 1,
      source: { type: 'harness', id: 'notes-cli-create', revision: 1 },
      operations: [
        {
          operationId: 'create-1',
          type: 'create',
          uri: noteUri(bound.repoId, id),
          expectedHash: null,
          relativePath: input.relativePath,
          afterMarkdown,
          dependsOn: [],
          noteDiagnostics: [],
        },
      ],
    },
    { requestDigest } as ApplyOpts,
  );
  if (!report.ok) return { ok: false, errors: report.errors };
  const relPath = report.results[0]?.relPath ?? '';
  const index = await buildNoteIndex(root);
  return { ok: true, data: { relPath, id, uri: index.repoId ? noteUri(index.repoId, id) : null }, errors: [] };
}

export interface CheckRow {
  relPath: string;
  id: string | null;
  diagnostics: Diagnostic[];
  foreign?: boolean;
  classification: import('@janus-agent/harness-node').IndexEntry['classification'];
  sourceHash: string | null;
}

function checkRow(entry: import('@janus-agent/harness-node').IndexEntry): CheckRow {
  return { relPath: entry.relPath, id: entry.note?.meta.id ?? null, diagnostics: entry.diagnostics, classification: entry.classification, sourceHash: entry.sourceHash, ...(entry.foreign ? { foreign: true } : {}) };
}

export async function cmdCheck(root: string): Promise<CliResult<{ files: number; rows: CheckRow[]; repoDiagnostics: Diagnostic[]; coverage: NoteCoverage; readDiagnostics: Diagnostic[] }>> {
  const index = await buildNoteIndex(root);
  const rows = index.entries.map(checkRow);
  const repoDiagnostics: Diagnostic[] = [...index.diagnostics];
  if (index.repoId) {
    const nodes = index.entries
      .filter((e) => e.note && e.diagnostics.length === 0)
      .map((e) => ({ uri: noteUri(index.repoId as string, (e.note as ParsedNote).meta.id), note: e.note as ParsedNote }));
    repoDiagnostics.push(...checkAcyclic(nodes));
    for (const edge of index.relations) {
      if (edge.resolution.status === 'missing' || edge.resolution.status === 'invalid' || edge.resolution.status === 'ambiguous') {
        repoDiagnostics.push(...edge.resolution.diagnostics.map((problem) => ({ ...problem, path: edge.sourceUri })));
      }
    }
  } else {
    repoDiagnostics.push({ code: 'NOT_READY', message: 'unbound repo (no harness.json): graph checks deferred' });
  }
  const rowErrors = rows.flatMap((r) => r.diagnostics);
  const repoErrors = repoDiagnostics.filter((d) => d.code !== 'NOT_READY');
  const bad = rowErrors.length > 0 || repoErrors.length > 0;
  return { ok: !bad, data: { files: index.entries.length, rows, repoDiagnostics, coverage: index.coverage, readDiagnostics: index.readDiagnostics }, errors: [...rowErrors, ...repoErrors] };
}

export async function cmdApply(
  root: string,
  changesetFile: string,
  opts: { selection?: string[]; allowDelete?: boolean } = {},
): Promise<CliResult<{ txId: string; applied: number }>> {
  let cs: { id: string; revision: number; source?: Record<string, unknown>; operations: Array<Record<string, unknown>> };
  try {
    cs = JSON.parse(await readFile(resolve(changesetFile), 'utf8'));
  } catch (e) {
    return { ok: false, errors: [{ code: 'SCHEMA_INVALID', message: `changeset unreadable: ${(e as Error).message}` }] };
  }
  const fileBytes = await readFile(resolve(changesetFile));
  const src = (cs.source ?? {}) as { type?: unknown; id?: unknown; revision?: unknown };
  const report = await applyChangeSet(
    root,
    {
      id: String(cs.id),
      revision: Number(cs.revision),
      source: {
        type: (['roundtable', 'chat', 'harness', 'manual'] as const).includes(src.type as 'manual') ? (src.type as 'manual') : 'manual',
        id: String(src.id ?? 'unknown'),
        revision: Number(src.revision ?? 1),
      },
      operations: (cs.operations ?? []).map((o) => ({
        operationId: String(o['operationId']),
        type: o['type'] as 'create' | 'replace' | 'delete',
        uri: String(o['uri']),
        expectedHash: (o['expectedHash'] as string | null) ?? null,
        relativePath: o['relativePath'] as string | undefined,
        afterMarkdown: o['afterMarkdown'] as string | undefined,
        dependsOn: (o['dependsOn'] as string[] | undefined) ?? [],
        noteDiagnostics: [],
      })),
    },
    { selection: opts.selection, allowDelete: opts.allowDelete, requestDigest: sha256HexBytes(fileBytes) },
  );
  if (!report.ok) return { ok: false, errors: report.errors };
  return { ok: true, data: { txId: report.txId, applied: report.results.length }, errors: [] };
}
