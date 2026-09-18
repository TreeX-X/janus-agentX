// Note: execution run records live here — see .agents/notes/implemented/architecture/2026-09-17-harness-dispatch-s8.md
/**
 * @file Harness run store (S8 slice 8a).
 * @description Local-only run records under `.agents/.local/runs/<runId>/`:
 *  run state, owner leases, receipts, repair packets, and handoff files.
 *  Run snapshots use atomic temp-file renames; receipts and leases use exclusive creation so two
 *  owners never hold one run. Leases never auto-expire: a dead owner needs
 *  an explicit, recorded takeover. Records are best-effort and rebuildable
 *  from task notes plus receipts; they never substitute the note truth.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BaselineInput,
  ExecutionState,
  HarnessMode,
} from '@janus-agent/harness-core';
import type { Receipt } from '@janus-agent/harness-core';

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

function receiptFile(root: string, runId: string, receiptId: string): string {
  assertRunId(receiptId, 'receipt');
  return join(runDir(root, runId), 'receipts', `${receiptId}.json`);
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

export async function saveRun(root: string, run: HarnessRun): Promise<void> {
  run.updatedAt = nowIso();
  await writeAtomic(runFile(root, run.runId), JSON.stringify(run, null, 2));
}

export async function loadRun(root: string, runId: string): Promise<HarnessRun> {  assertRunId(runId, 'run');
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

export async function releaseLease(root: string, runId: string): Promise<void> {
  try {
    await unlink(leaseFile(root, runId));
  } catch {
    // Already released: releasing is idempotent.
  }
}

export async function storeReceipt(root: string, runId: string, receipt: Receipt): Promise<void> {
  const path = receiptFile(root, runId, receipt.id);
  const bytes = JSON.stringify(receipt, null, 2);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx', encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Same request is retryable; an existing id never authorizes new evidence.
    if (await readFile(path, 'utf8') !== bytes) throw new RunStoreError('CONFLICT', `receipt ${receipt.id} already exists with different content`);
  }
}

export async function loadReceipt(root: string, runId: string, receiptId: string): Promise<Receipt> {
  assertRunId(receiptId, 'receipt');
  try {
    return JSON.parse(await readFile(receiptFile(root, runId, receiptId), 'utf8')) as Receipt;
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
