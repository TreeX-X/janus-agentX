// Note: execution run records live here — see .agents/notes/implemented/architecture/2026-09-17-harness-dispatch-s8.md
/**
 * @file Harness run store (S8 slice 8a).
 * @description Local-only run records under `.agents/.local/runs/<runId>/`:
 *  run state, owner leases, repair packets, and handoff files.
 *  Task execution and formal receipts share the asset journal with run snapshots. Leases use exclusive creation so two
 *  owners never hold one run. Leases never auto-expire: a dead owner needs
 *  an explicit, recorded takeover. Records are best-effort and rebuildable
 *  from task notes plus receipts; they never substitute the note truth.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BaselineInput,
  ExecutionState,
  HarnessMode,
} from '@janus-agent/harness-core';
import type { Receipt } from '@janus-agent/harness-core';
import { parseNote, patchTaskExecution, receiptContentHash, taskContractHash, validateNote, validateReceiptShape, type TaskExecution } from '@janus-agent/harness-core';
import { assertAssetPath, buildNoteIndex, commitAssetFiles, sha256HexBytes, withAssetLock, type CrashInject } from '@janus-agent/harness-node';

export interface RunLease {
  owner: string;
  token: string;
  since: string;
}

export interface CodeRow {
  repoId: string;
  path: string;
  sha256?: string;
  deleted?: boolean;
}

export interface RepairRecord {
  attempt: number;
  auto: boolean;
  failureReceiptId: string;
  summary: string;
  at: string;
}

export interface TakeoverRecord {
  from: string;
  to: string;
  reason: string;
  at: string;
}

export interface HarnessRun {
  schema: 'harness-run/1';
  runId: string;
  taskUri: string;
  mode: HarnessMode;
  state: ExecutionState;
  attempt: number;
  executor: 'internal' | 'external';
  lease: RunLease | null;
  baseline: { taskContractHash: string; inputs: BaselineInput[] };
  verification?: { codeManifest: CodeRow[]; recordedAt: string };
  repairBudget: { maxAuto: number; usedAuto: number };
  repairs: RepairRecord[];
  receipts: string[];
  /** The receipt that passed finish; later failures never substitute it. */
  completedReceiptId?: string;
  takeovers: TakeoverRecord[];
  closeout: 'commit-required' | 'working-tree-authorized';
  authorizationRef?: string;
  pausedFrom?: ExecutionState;
  blocker?: { code: string; summary: string };
  createdAt: string;
  updatedAt: string;
  revision?: number;
  /** File hash captured when loading the task, for compare-and-swap writes. */
  noteHash?: string;
}

export class RunStoreError extends Error {
  readonly code: 'NOT_FOUND' | 'CORRUPT' | 'BUSY' | 'IO_ERROR' | 'BAD_ID' | 'CONFLICT';
  constructor(code: RunStoreError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertRunId(id: string, what: string): void {
  if (!ID_RE.test(id)) throw new RunStoreError('BAD_ID', `${what} has an unsafe id: ${id}`);
}

export function runsDir(root: string): string {
  return join(root, '.agents', '.local', 'runs');
}

export function runDir(root: string, runId: string): string {
  assertRunId(runId, 'run');
  return join(runsDir(root), runId);
}

function runFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'run.json');
}

function leaseFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'lease.json');
}

export function handoffFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'handoff.md');
}

function repairFile(root: string, runId: string, attempt: number): string {
  return join(runDir(root, runId), 'repairs', `attempt-${attempt}.json`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

async function writeAtomic(path: string, text: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    throw new RunStoreError('IO_ERROR', `write failed for ${path}: ${(e as Error).message}`);
  }
}

export function newRunId(): string {
  return randomUUID();
}

export function newLeaseToken(): string {
  return randomUUID();
}

export function runExecution(run: HarnessRun): TaskExecution {
  return { mode: run.mode, state: run.state, baseline: run.baseline, attempt: run.attempt,
    receipts: run.receipts, closeout: run.closeout,
    ...(run.blocker ? { blocker: run.blocker } : {}),
    ...(run.authorizationRef ? { authorizationRef: run.authorizationRef } : {}) };
}

async function taskEntry(root: string, taskUri: string) {
  const index = await buildNoteIndex(root);
  const entry = index.byId.get(taskUri.split('/').pop()!);
  if (!taskUri.startsWith(`note://${index.repoId}/`) || !entry?.note || entry.note.meta.kind !== 'task') throw Object.assign(new Error(`task not found: ${taskUri}`), { code: 'NOT_FOUND' });
  if (index.diagnostics.length || entry.diagnostics.length) throw Object.assign(new Error('task repository has invalid identity or task metadata'), { code: 'SCHEMA_INVALID' });
  await assertAssetPath(root, entry.relPath);
  return entry as typeof entry & { note: NonNullable<typeof entry.note> };
}

// Note: Note, receipt and local cache commit together - see .agents/notes/implemented/architecture/2026-09-18-harness-portable-results.md
export async function saveRun(root: string, run: HarnessRun, receipt?: Receipt, inject?: CrashInject): Promise<void> {
  await withAssetLock(root, async () => {
    const localPath = `.agents/.local/runs/${run.runId}/run.json`;
    assertRunId(run.runId, 'run');
    await assertAssetPath(root, localPath);
    let previousBytes: Buffer | null = null;
    try { previousBytes = await readFile(join(root, localPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const previous = previousBytes ? JSON.parse(previousBytes.toString('utf8')) as HarnessRun : undefined;
    if ((previous?.revision ?? 0) !== (run.revision ?? 0) || (!previous && run.revision)) throw Object.assign(new Error('run changed; reload before retrying'), { code: 'CONFLICT' });
    const expectedLease = run.lease ?? previous?.lease;
    if (expectedLease && (await readLease(root, run.runId))?.token !== expectedLease.token) throw Object.assign(new Error('lease changed during operation'), { code: 'BUSY' });
    const entry = await taskEntry(root, run.taskUri);
    if (run.noteHash && entry.sha256 !== run.noteHash) throw Object.assign(new Error('task changed during operation'), { code: 'CONFLICT' });
    if (!previous && entry.note.meta.execution) throw Object.assign(new Error('task already has execution; reattach its owner or inspect its portable result'), { code: 'NOT_READY' });
    if (previous && JSON.stringify(entry.note.meta.execution) !== JSON.stringify(runExecution(previous))) throw Object.assign(new Error('task execution differs from the local run; explicit recovery required'), { code: 'CONFLICT' });
    if (entry.note.meta.lifecycle !== 'accepted') throw Object.assign(new Error('execution requires an accepted task'), { code: 'NOT_READY' });
    if (!['paused', 'blocked', 'cancelled'].includes(run.state) && taskContractHash(entry.note) !== run.baseline.taskContractHash) throw Object.assign(new Error('task contract changed'), { code: 'STALE_BASELINE' });
    const text = await readFile(join(root, entry.relPath), 'utf8');
    if (sha256HexBytes(Buffer.from(text)) !== entry.sha256) throw Object.assign(new Error('task changed while reading'), { code: 'CONFLICT' });
    const after = patchTaskExecution(text, runExecution(run));
    const parsed = parseNote(after);
    if (validateNote(parsed).length || taskContractHash(parsed) !== taskContractHash(entry.note)) throw Object.assign(new Error('execution update changed or invalidated the contract'), { code: 'SCHEMA_INVALID' });
    const files: Array<{ path: string; before: string | null; after: string | null }> = [];
    for (const id of run.receipts) {
      assertRunId(id, 'receipt');
      const path = `.agents/evidence/${id}.json`;
      await assertAssetPath(root, path);
      let bytes: string | null = null;
      try { bytes = await readFile(join(root, path), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (receipt?.id === id) {
        if (validateReceiptShape(receipt).length) throw Object.assign(new Error('invalid receipt'), { code: 'SCHEMA_INVALID' });
        const expected = JSON.stringify(receipt, null, 2);
        if (bytes !== null && receiptContentHash(JSON.parse(bytes)) !== receiptContentHash(receipt)) throw new RunStoreError('CONFLICT', `receipt ${id} already exists with different content`);
        if (bytes === null) files.push({ path, before: null, after: expected });
      } else if (bytes === null) throw Object.assign(new Error(`formal receipt missing: ${id}`), { code: 'RECOVERY_REQUIRED' });
    }
    const next = { ...run, revision: (run.revision ?? 0) + 1, updatedAt: nowIso(), noteHash: sha256HexBytes(Buffer.from(after)) };
    files.push({ path: entry.relPath, before: entry.sha256, after });
    files.push({ path: localPath, before: previousBytes ? sha256HexBytes(previousBytes) : null, after: JSON.stringify(next, null, 2) });
    if (!run.lease && previous?.lease) {
      const leaseBytes = await readFile(leaseFile(root, run.runId));
      files.push({ path: `.agents/.local/runs/${run.runId}/lease.json`, before: sha256HexBytes(leaseBytes), after: null });
    }
    await commitAssetFiles(root, files, inject);
    Object.assign(run, next);
  });
}

async function readRun(root: string, runId: string): Promise<HarnessRun> {
  assertRunId(runId, 'run');
  let raw: string;
  try {
    raw = await readFile(runFile(root, runId), 'utf8');
  } catch {
    throw new RunStoreError('NOT_FOUND', `unknown run: ${runId}`);
  }
  try {
    const run = JSON.parse(raw) as HarnessRun;
    if (run?.schema !== 'harness-run/1' || run.runId !== runId) {
      throw new Error('run identity mismatch');
    }
    return run;
  } catch (e) {
    if (e instanceof RunStoreError) throw e;
    throw new RunStoreError('CORRUPT', `run record unreadable: ${runId}`);
  }
}

export async function loadRun(root: string, runId: string): Promise<HarnessRun> {
  return withAssetLock(root, async () => {
    const run = await readRun(root, runId);
    const entry = await taskEntry(root, run.taskUri);
    if (JSON.stringify(entry.note.meta.execution) !== JSON.stringify(runExecution(run))) throw Object.assign(new Error('task execution differs from the local run'), { code: 'CONFLICT' });
    run.noteHash = entry.sha256;
    return run;
  });
}

/** Every readable run record, newest first. Unreadable entries are skipped, never fatal. */
export async function listRuns(root: string): Promise<HarnessRun[]> {
  let names: string[] = [];
  try {
    names = (await readdir(runsDir(root), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: HarnessRun[] = [];
  for (const name of names) {
    try {
      out.push(await loadRun(root, name));
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Exclusive lease claim. Returns the current holder instead of overwriting. */
export async function acquireLease(
  root: string,
  runId: string,
  owner: string,
): Promise<{ acquired: true; lease: RunLease } | { acquired: false; holder: RunLease | null }> {
  return withAssetLock(root, () => claimLease(root, runId, owner));
}

async function claimLease(root: string, runId: string, owner: string): Promise<{ acquired: true; lease: RunLease } | { acquired: false; holder: RunLease | null }> {
  const path = leaseFile(root, runId);
  const lease: RunLease = { owner, token: newLeaseToken(), since: nowIso() };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(lease, null, 2), { flag: 'wx', encoding: 'utf8' });
    return { acquired: true, lease };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new RunStoreError('IO_ERROR', `lease claim failed for ${runId}: ${(e as Error).message}`);
    }
  }
  try {
    const holder = JSON.parse(await readFile(path, 'utf8')) as RunLease;
    return { acquired: false, holder };
  } catch {
    return { acquired: false, holder: null };
  }
}

export async function readLease(root: string, runId: string): Promise<RunLease | null> {
  try {
    return JSON.parse(await readFile(leaseFile(root, runId), 'utf8')) as RunLease;
  } catch {
    return null;
  }
}

export async function releaseLease(root: string, runId: string, expectedToken?: string): Promise<void> {
  await withAssetLock(root, async () => {
    if (expectedToken && (await readLease(root, runId))?.token !== expectedToken) return;
    try { await unlink(leaseFile(root, runId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  });
}

export async function loadReceipt(root: string, runId: string, receiptId: string): Promise<Receipt> {
  assertRunId(receiptId, 'receipt');
  try {
    const path = `.agents/evidence/${receiptId}.json`;
    await assertAssetPath(root, path);
    const receipt = JSON.parse(await readFile(join(root, path), 'utf8')) as Receipt;
    if (receipt.id !== receiptId || validateReceiptShape(receipt).length) throw new Error('invalid formal receipt');
    return receipt;
  } catch {
    throw new RunStoreError('NOT_FOUND', `unknown receipt ${receiptId} on run ${runId}`);
  }
}

export async function storeRepairPacket(
  root: string,
  runId: string,
  record: RepairRecord & { constraints?: string[] },
): Promise<void> {
  await writeAtomic(repairFile(root, runId, record.attempt), JSON.stringify(record, null, 2));
}

/** Factual handoff for an external executor: ids, hashes, budget, and the
 * rules for coming back. Local-only: the lease token rides along because
 * `.local` never enters shared exports. No CLI syntax is promised here. */
export function buildHandoffMarkdown(run: HarnessRun): string {
  const lines = [
    '# Harness run handoff',
    '',
    `run: ${run.runId}`,
    `task: ${run.taskUri}`,
    `mode: ${run.mode}`,
    `state: ${run.state}`,
    `attempt: ${run.attempt}`,
    `executor: ${run.executor}`,
    `closeout: ${run.closeout}`,
    ...(run.authorizationRef ? [`authorization: ${run.authorizationRef}`] : []),
    '',
    '## Fixed baseline',
    '',
    `contract: ${run.baseline.taskContractHash}`,
    ...run.baseline.inputs.map((input) =>
      `- ${input.uri} :: ${input.contentHash}${input.criteria ? ` [${input.criteria.join(', ')}]` : ''}`),
    '',
    '## Repair budget',
    '',
    `automatic repairs used: ${run.repairBudget.usedAuto}/${run.repairBudget.maxAuto}`,
    ...(run.receipts.length > 0 ? ['', '## Receipts so far', '', ...run.receipts.map((id) => `- ${id}`)] : []),
    ...(run.lease ? ['', '## Current lease (local-only)', '', `owner: ${run.lease.owner}`, `token: ${run.lease.token}`, `since: ${run.lease.since}`] : []),
    '',
    '## Coming back',
    '',
    '- Continue the same Task URI against the fixed baseline above; a moved contract needs a rebaseline, not a silent retry.',
    '- Completion needs a valid receipt for the current attempt covering every required check and criterion.',
    '- On failure, repair with the failing receipt id and a short summary; automatic repairs are budgeted, manual repairs need authorization.',
    '',
  ];
  return lines.join('\n');
}

export async function writeHandoff(root: string, run: HarnessRun): Promise<string> {
  const path = handoffFile(root, run.runId);
  await writeAtomic(path, buildHandoffMarkdown(run));
  return path;
}

export interface LaunchRecord {
  providerId: string;
  program: string;
  args: string[];
  pid: number | null;
  by: string;
  at: string;
}

function launchesFile(root: string, runId: string): string {
  return join(runDir(root, runId), 'launches.jsonl');
}

/**
 * External launch history: every spawned process for a run, newest last.
 * Local-only, never shared. The record never proves completion: process
 * exit is an event, and only files plus the shared kernel decide evidence.
 */
export async function recordLaunch(root: string, runId: string, record: LaunchRecord): Promise<void> {
  assertRunId(runId, 'run');
  await mkdir(dirname(launchesFile(root, runId)), { recursive: true });
  await appendFile(launchesFile(root, runId), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readLaunches(root: string, runId: string): Promise<LaunchRecord[]> {
  assertRunId(runId, 'run');
  let text: string;
  try {
    text = await readFile(launchesFile(root, runId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new RunStoreError('IO_ERROR', `read failed for launches of ${runId}: ${(error as Error).message}`);
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as LaunchRecord);
}
