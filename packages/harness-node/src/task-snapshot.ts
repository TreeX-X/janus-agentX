// Note: execution evidence uses shared file snapshots - see .agents/notes/implemented/architecture/2026-09-18-harness-task-execution.md
import { criterionHash, taskContractHash, type Diagnostic, type WorkContract } from '@janus-agent/harness-core';
import { collectTaskBaseline } from './baseline.js';
import { buildNoteIndex } from './repository.js';

export async function collectTaskSnapshot(root: string, taskRef: string) {
  try { return await collectSnapshot(root, taskRef); }
  catch (error) { return { ok: false as const, errors: [{ code: 'IO_ERROR' as const, message: String(error) }] }; }
}

async function collectSnapshot(root: string, taskRef: string) {
  const base = await collectTaskBaseline(root, taskRef);
  if (!base.ok) return { ok: false as const, errors: base.problems };
  const index = await buildNoteIndex(root);
  const task = index.byId.get(base.baseline.taskUri.split('/').pop()!)?.note;
  const fail = (code: Diagnostic['code'], message: string) => ({ ok: false as const, errors: [{ code, message }] });
  if (!task?.meta.work) return fail('NOT_READY', 'task work contract is missing');
  if (taskContractHash(task) !== base.baseline.taskContractHash) return fail('STALE_BASELINE', 'task moved while collecting evidence');
  const work: WorkContract = task.meta.work;
  const criterionHashes: Array<[string, Array<[string, string]>]> = [];
  const notes: Array<{ uri: string; title: string; sections: typeof task.sections }> = [];
  for (const uri of new Set([base.baseline.taskUri, ...base.baseline.inputs.map((row) => row.uri), ...work.acceptanceRefs.map((ref) => ref.uri)])) {
    if (!uri.startsWith(`note://${index.repoId}/`)) return fail('UNRESOLVED_REFERENCE', `note belongs to another checkout: ${uri}`);
    const entry = index.byId.get(uri.split('/').pop()!);
    if (!entry?.note) return fail('NOT_FOUND', `note vanished mid-snapshot: ${uri}`);
    notes.push({ uri, title: entry.note.title, sections: entry.note.sections });
    criterionHashes.push([uri, entry.note.acs.map((ac) => [ac.id, criterionHash(`- [ ] ${ac.id}: ${ac.text}`)])]);
  }
  return { ok: true as const, repoId: index.repoId!, baseline: base.baseline, work, notes, criterionHashes };
}

export async function collectLiveSnapshot(root: string, taskRef: string, implementor: string, codeHashes: Array<[string, string | null]>) {
  const snapshot = await collectTaskSnapshot(root, taskRef);
  if (!snapshot.ok) return snapshot;
  return { ok: true as const, live: {
    taskContractHash: snapshot.baseline.taskContractHash,
    inputHashes: snapshot.baseline.inputs.map((row) => [row.uri, row.contentHash] as [string, string]),
    criterionHashes: snapshot.criterionHashes,
    codeHashes,
    acceptanceRefs: snapshot.work.acceptanceRefs,
    verification: snapshot.work.verification,
    implementor,
  } };
}
