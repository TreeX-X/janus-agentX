// Note: portable results are derived from formal assets - see .agents/notes/implemented/architecture/2026-09-18-harness-portable-results.md
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canon, parseNote, receiptContentHash, taskContractHash, validateNote, validateReceiptShape, type Diagnostic, type ParsedNote, type Receipt, type TaskExecution } from '@janus-agent/harness-core';
import { receiptProblems } from './baseline.js';
import { gitFileAt, landingCandidates, runGit } from './git-evidence.js';
import { buildNoteIndex, noteUri, sha256HexBytes } from './repository.js';
import { assertAssetPath, withAssetLock } from './transaction.js';

export interface TaskCloseout {
  strategy: TaskExecution['closeout'];
  satisfied: boolean;
  worktreeMatches: boolean;
  commit?: string;
  detail: string;
}

export interface TaskResult {
  taskUri: string;
  execution?: TaskExecution;
  validity: 'unverified' | 'valid' | 'stale';
  validReceipts: string[];
  closeout?: TaskCloseout;
  errors: Diagnostic[];
}

async function checkLanding(root: string, taskPath: string, execution: TaskExecution, receipt: Receipt): Promise<TaskCloseout> {
  const report: TaskCloseout = { strategy: execution.closeout, satisfied: false, worktreeMatches: true, detail: 'no current-branch commit contains the task, receipt and tested files' };
  if (execution.closeout === 'working-tree-authorized') {
    return { ...report, satisfied: Boolean(execution.authorizationRef), detail: execution.authorizationRef ? 'verified working tree under explicit authorization; no commit claimed' : 'missing working-tree authorization' };
  }
  const receiptPath = `.agents/evidence/${receipt.id}.json`;
  const paths = ['.agents/notes', receiptPath, ...receipt.codeManifest.map((row) => row.path)];
  for (const commit of landingCandidates(root, paths)) {
    const storedReceipt = gitFileAt(root, commit, receiptPath);
    if (!storedReceipt.ok || !storedReceipt.bytes) continue;
    try { if (receiptContentHash(JSON.parse(storedReceipt.bytes.toString('utf8'))) !== receiptContentHash(receipt)) continue; }
    catch { continue; }
    const note = committedTask(root, commit, taskPath, receipt.taskUri!.split('/').pop()!);
    if (!note || taskContractHash(note) !== receipt.taskContractHash || note.meta.execution?.state !== 'done' ||
      note.meta.execution.mode !== receipt.mode || note.meta.execution.attempt !== receipt.attempt || !note.meta.execution.receipts.includes(receipt.id) ||
      note.meta.execution.baseline.taskContractHash !== receipt.taskContractHash || canon(note.meta.execution.baseline.inputs) !== canon(execution.baseline.inputs)) continue;
    const matches = receipt.codeManifest.every((row) => {
      const file = gitFileAt(root, commit, row.path);
      return file.ok && (row.deleted ? file.bytes === null : file.bytes !== null && sha256HexBytes(file.bytes) === row.sha256);
    });
    if (matches) return { ...report, satisfied: true, commit, detail: `${commit.slice(0, 12)} contains the task, immutable receipt and tested files` };
  }
  return report;
}

function committedTask(root: string, commit: string, currentPath: string, id: string): ParsedNote | undefined {
  const read = (path: string): ParsedNote | undefined => {
    const file = gitFileAt(root, commit, path);
    if (!file.ok || !file.bytes) return undefined;
    try {
      const note = parseNote(file.bytes.toString('utf8'));
      return note.meta.id === id && note.meta.kind === 'task' && !validateNote(note).length ? note : undefined;
    } catch { return undefined; }
  };
  const current = read(currentPath);
  if (current) return current;
  const files = runGit(root, ['ls-tree', '-r', '--name-only', '-z', commit, '--', '.agents/notes']);
  if (!files.ok) return undefined;
  for (const path of files.stdout.split('\0').filter((path) => path.endsWith('.md'))) {
    const note = read(path);
    if (note) return note;
  }
  return undefined;
}

/** No local run is needed. Reading foreign running state never claims its lease. */
export async function readTaskResult(root: string, ref: string, options: { closeout?: boolean; receiptId?: string } = {}): Promise<TaskResult> {
  const result: TaskResult = { taskUri: ref, validity: 'unverified', validReceipts: [], errors: [] };
  try {
    return await withAssetLock(root, async () => {
      const index = await buildNoteIndex(root);
      const entry = index.byId.get(ref.split('/').pop()!) ?? index.entries.find((item) => item.relPath === ref || item.relPath === `.agents/notes/${ref}`);
      if (!index.repoId || (ref.startsWith('note://') && !ref.startsWith(`note://${index.repoId}/`)) || !entry?.note || entry.note.meta.kind !== 'task') {
        result.errors.push({ code: 'NOT_FOUND', message: `task not found: ${ref}` });
        return result;
      }
      result.taskUri = noteUri(index.repoId, entry.note.meta.id);
      result.errors.push(...index.diagnostics, ...entry.diagnostics);
      if (result.errors.length) return result;
      result.execution = entry.note.meta.execution;
      if (result.execution?.state !== 'done') return result;
      result.validity = 'stale';
      for (const id of result.execution.receipts) {
        if (options.receiptId && id !== options.receiptId) continue;
        try {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('unsafe receipt id');
          const path = `.agents/evidence/${id}.json`;
          await assertAssetPath(root, path);
          const bytes = await readFile(join(root, path));
          const receipt = JSON.parse(bytes.toString('utf8')) as Receipt;
          if (validateReceiptShape(receipt).length || receipt.id !== id || receipt.taskUri !== result.taskUri) {
            result.errors.push({ code: 'SCHEMA_INVALID', message: `receipt ${id} is malformed or targets another task` });
            continue;
          }
          const problems = await receiptProblems(root, index.repoId, receipt);
          if (problems.length) { result.errors.push(...problems); continue; }
          result.validReceipts.push(id);
          result.validity = 'valid';
          if (options.closeout) {
            const closeout = await checkLanding(root, entry.relPath, result.execution, receipt);
            if (!result.closeout || closeout.satisfied) result.closeout = closeout;
          }
        } catch (error) { result.errors.push({ code: 'NOT_READY', message: `receipt ${id} unavailable: ${(error as Error).message}` }); }
      }
      if (result.validity === 'valid') result.errors = [];
      else {
        if (!result.errors.length) result.errors.push({ code: 'NOT_READY', message: 'done task has no current formal evidence' });
        if (options.closeout) result.closeout = { strategy: result.execution.closeout, satisfied: false, worktreeMatches: false, detail: 'no current valid formal receipt' };
      }
      return result;
    });
  } catch (error) {
    result.errors.push({ code: (error as { code?: Diagnostic['code'] }).code ?? 'IO_ERROR', message: (error as Error).message });
    return result;
  }
}

export async function listTaskResults(root: string): Promise<TaskResult[]> {
  const index = await withAssetLock(root, () => buildNoteIndex(root));
  if (!index.repoId) return [];
  const results: TaskResult[] = [];
  for (const entry of index.entries) {
    if (entry.note?.meta.kind === 'task' && entry.note.meta.execution) results.push(await readTaskResult(root, noteUri(index.repoId, entry.note.meta.id)));
  }
  return results;
}
