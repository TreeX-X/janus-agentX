/**
 * notes-cli command functions (contract C5, surface half).
 * Pure against an explicit root: no process.cwd, no console, no exit.
 * Every result carries `{ok, data?, errors[]}`; `exitFor` maps to the
 * fixed CLI codes 0/2/3/4/5/6. `cli.ts` only parses argv and prints.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkAcyclic,
  parseNote,
  unresolvedTargets,
  validateNote,
  type Diagnostic,
  type ParsedNote,
} from '@janus-agent/harness-core';
import {
  applyChangeSet,
  buildNoteIndex,
  noteUri,
  sha256HexBytes,
  type ApplyOpts,
} from '@janus-agent/harness-node';

export interface CliResult<T = unknown> {
  ok: boolean;
  data?: T;
  errors: Diagnostic[];
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
  id: string;
  uri: string | null;
  title: string;
  kind: string;
  lifecycle: string;
  relPath: string;
}

export async function cmdList(
  root: string,
  filters: { kind?: string; lifecycle?: string; tag?: string; q?: string } = {},
): Promise<CliResult<{ notes: NoteSummary[] }>> {
  const index = await buildNoteIndex(root);
  const notes: NoteSummary[] = [];
  for (const e of index.entries) {
    if (!e.note) continue;
    const m = e.note.meta;
    if (filters.kind && m.kind !== filters.kind) continue;
    if (filters.lifecycle && m.lifecycle !== filters.lifecycle) continue;
    if (filters.tag && !(m.tags ?? []).includes(filters.tag)) continue;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!e.note.title.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) continue;
    }
    notes.push({
      id: m.id,
      uri: index.repoId ? noteUri(index.repoId, m.id) : null,
      title: e.note.title,
      kind: m.kind,
      lifecycle: m.lifecycle,
      relPath: e.relPath,
    });
  }
  notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { ok: true, data: { notes }, errors: [] };
}

export async function cmdShow(root: string, ref: string): Promise<CliResult<{ text: string; sha256: string; summary: NoteSummary }>> {
  const index = await buildNoteIndex(root);
  const id = ref.includes('://') ? ref.split('/').pop() ?? ref : ref;
  let entry = index.byId.get(id);
  entry ??= index.entries.find((e) => e.relPath === ref || e.relPath.endsWith(`/${ref}`));
  if (!entry || !entry.note) {
    return { ok: false, errors: [{ code: 'NOT_FOUND', message: `unknown note: ${ref}` }] };
  }
  const text = await readFile(resolve(root, entry.relPath), 'utf8');
  return {
    ok: true,
    data: {
      text,
      sha256: entry.sha256,
      summary: {
        id: entry.note.meta.id,
        uri: index.repoId ? noteUri(index.repoId, entry.note.meta.id) : null,
        title: entry.note.title,
        kind: entry.note.meta.kind,
        lifecycle: entry.note.meta.lifecycle,
        relPath: entry.relPath,
      },
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
  relativePath?: string;
}

export async function cmdCreate(root: string, input: CreateInput): Promise<CliResult<{ relPath: string; id: string; uri: string | null }>> {
  const bound = await buildNoteIndex(root);
  if (!bound.repoId) {
    return { ok: false, errors: [{ code: 'NOT_READY', message: 'init .agents/harness.json with a repoId first' }] };
  }
  const created = new Date().toISOString().slice(0, 10);
  const id = randomUUID().toLowerCase();
  const body = [`# ${input.title}`, '']
    .concat(...Object.entries(input.sections).flatMap(([name, text]) => [`## ${name}`, '', text, '']))
    .join('\n');
  const meta = {
    schema: 'harness-note/1',
    id,
    kind: input.kind,
    lifecycle: input.lifecycle ?? 'draft',
    created,
    ...(input.class ? { class: input.class } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  };
  const fmLines = Object.entries(meta).map(([k, v]) => `${k}: ${formatYamlValue(v)}`);
  const afterMarkdown = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
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

function formatYamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'string' && /[:#\s]/.test(x) ? JSON.stringify(x) : String(x))).join(', ')}]`;
  if (typeof v === 'string' && /[:#\n]/.test(v)) return JSON.stringify(v);
  return String(v);
}

export interface CheckRow {
  relPath: string;
  id: string | null;
  diagnostics: Diagnostic[];
}

export async function cmdCheck(root: string): Promise<CliResult<{ files: number; rows: CheckRow[]; repoDiagnostics: Diagnostic[] }>> {
  const index = await buildNoteIndex(root);
  const rows: CheckRow[] = index.entries.map((e) => ({ relPath: e.relPath, id: e.note?.meta.id ?? null, diagnostics: e.diagnostics }));
  const repoDiagnostics: Diagnostic[] = [...index.diagnostics];
  if (index.repoId) {
    const nodes = index.entries
      .filter((e) => e.note && e.diagnostics.length === 0)
      .map((e) => ({ uri: noteUri(index.repoId as string, (e.note as ParsedNote).meta.id), note: e.note as ParsedNote }));
    repoDiagnostics.push(...checkAcyclic(nodes));
    for (const u of unresolvedTargets(nodes)) {
      repoDiagnostics.push({ code: 'UNRESOLVED_REFERENCE', message: `unresolved: ${u.target}`, path: u.from });
    }
  } else {
    repoDiagnostics.push({ code: 'NOT_READY', message: 'unbound repo (no harness.json): graph checks deferred' });
  }
  const rowErrors = rows.flatMap((r) => r.diagnostics);
  const repoErrors = repoDiagnostics.filter((d) => d.code !== 'NOT_READY');
  const bad = rowErrors.length > 0 || repoErrors.length > 0;
  return { ok: !bad, data: { files: index.entries.length, rows, repoDiagnostics }, errors: [...rowErrors, ...repoErrors] };
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
