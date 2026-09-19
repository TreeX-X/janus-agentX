// Note: execution dispatch lives here — see .agents/notes/implemented/architecture/2026-09-17-harness-dispatch-s8.md
/**
 * @file Harness run dispatcher (S8 slice 8a).
 * @description Owns run records from dispatch to closeout: transitions run
 *  through the shared `checkOp` table, leases through exclusive files, and
 *  receipts through shape plus live-validity gates. Every op returns
 *  diagnostics instead of throwing for contract violations; only run-store
 *  IO failures surface as IO_ERROR diagnostics. The dispatcher never runs
 *  models, shells, or notes itself: hashing, execution, and Git stay with
 *  the caller and the harness-node primitives.
 */
import {
  checkOp,
  evaluateReceipt,
  receiptContentHash,
  nextAttempt,
  validateReceiptShape,
  HEX64_RE,
  NOTE_URI_RE,
  codeKey,
  type BaselineInput,
  type AcceptanceRef,
  type VerificationStep,
  type Diagnostic,
  type ExecutionState,
  type HarnessMode,
  type Receipt,
  type TaskExecution,
  type TaskOp,
  type ValidityContext,
} from '@janus-agent/harness-core';
import {
  readTaskResult,
} from '@janus-agent/harness-node';
import {
  acquireLease,
  loadReceipt,
  loadRun,
  newRunId,
  nowIso,
  readLease,
  releaseLease,
  saveRun,
  storeRepairPacket,
  writeHandoff,
  RunStoreError,
  type CodeRow,
  type HarnessRun,
} from './run-store.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

export interface OpResult<T = undefined> {
  ok: boolean;
  run: HarnessRun | null;
  errors: Diagnostic[];
  data: T;
}

function fail<T>(run: HarnessRun | null, errors: Diagnostic[], data: T): OpResult<T> {
  return { ok: false, run, errors, data };
}

function pass<T>(run: HarnessRun, data: T): OpResult<T> {
  return { ok: true, run, errors: [], data };
}

function storeError(e: unknown, run: HarnessRun | null): Diagnostic[] {
  if (e instanceof RunStoreError) {
    const code = e.code === 'NOT_FOUND' ? 'NOT_FOUND'
      : e.code === 'CORRUPT' ? 'RECOVERY_REQUIRED'
      : e.code === 'BAD_ID' ? 'SCHEMA_INVALID' : e.code === 'CONFLICT' ? 'CONFLICT' : 'IO_ERROR';
    return [diag(code as Diagnostic['code'], e.message)];
  }
  const code = (e as { code?: Diagnostic['code'] }).code;
  if (code && ['NOT_FOUND', 'NOT_READY', 'BUSY', 'CONFLICT', 'STALE_BASELINE', 'RECOVERY_REQUIRED', 'SCHEMA_INVALID', 'PERMISSION_DENIED'].includes(code)) return [diag(code, (e as Error).message)];
  return [diag('IO_ERROR', `run store failed: ${(e as Error).message}`)];
}

export interface DispatchInput {
  taskUri: string;
  mode: HarnessMode;
  taskContractHash: string;
  inputs: BaselineInput[];
  closeout: HarnessRun['closeout'];
  authorizationRef?: string;
  maxAutoRepairs?: number;
  executor?: 'internal' | 'external';
}

export interface StartPreconditions {
  baselineValid: boolean;
  dependenciesReady: boolean;
  authorization: { by: string; ref?: string } | null;
}

export interface RepairPacket {
  failureReceiptId: string;
  summary: string;
  auto: boolean;
  authorization?: { by: string; ref?: string } | null;
  constraints?: string[];
}

export interface LiveSnapshot {
  taskContractHash: string;
  inputHashes: Array<[string, string]>;
  criterionHashes: Array<[string, Array<[string, string]>]>;
  codeHashes: Array<[string, string | null]>;
  acceptanceRefs: AcceptanceRef[];
  verification: VerificationStep[];
  implementor: string;
}

export interface CloseoutCheck {
  repoRoot: string;
}

export interface CloseoutReport {
  strategy: HarnessRun['closeout'];
  satisfied: boolean;
  commit?: string;
  worktreeMatches: boolean;
  detail: string;
}

function toValidityContext(live: LiveSnapshot): ValidityContext {
  return {
    taskContractHash: live.taskContractHash,
    inputHashes: new Map(live.inputHashes),
    criterionHashes: new Map(live.criterionHashes.map(([uri, pairs]) => [uri, new Map(pairs)])),
    codeHashes: new Map(live.codeHashes),
    acceptanceRefs: live.acceptanceRefs,
    verification: live.verification,
    implementor: live.implementor,
  };
}

function checkedState(run: HarnessRun, op: TaskOp, ctx: Parameters<typeof checkOp>[2]): Diagnostic[] {
  return checkOp(run.state, op, ctx);
}

function idleCtx(): Parameters<typeof checkOp>[2] {
  return {
    lifecycle: 'accepted',
    workReady: true,
    baselineValid: true,
    dependenciesReady: true,
    authorized: true,
    leaseHeld: true,
    receiptReady: true,
    repairBudgetLeft: true,
  };
}

/** Compare complete sets, including absence/deletion and criterion subsets. */
function inputKey(inputs: BaselineInput[]): string {
  return JSON.stringify(inputs.map((row) => [row.uri, row.contentHash, [...(row.criteria ?? [])].sort()]).sort());
}

function manifestKey(rows: CodeRow[]): string {
  return JSON.stringify(rows.map((row) => [row.repoId, row.path, row.sha256 ?? null, row.deleted === true]).sort());
}

export async function dispatchRun(root: string, input: DispatchInput): Promise<OpResult<{ runId: string }>> {
  const errors: Diagnostic[] = [];
  if (!NOTE_URI_RE.test(input.taskUri)) errors.push(diag('SCHEMA_INVALID', `bad task URI: ${input.taskUri}`, 'taskUri'));
  if (!['xdo', 'xdel', 'xflow'].includes(input.mode)) errors.push(diag('SCHEMA_INVALID', `bad mode: ${input.mode}`, 'mode'));
  if (!HEX64_RE.test(input.taskContractHash)) errors.push(diag('SCHEMA_INVALID', 'task contract hash must be hex64', 'taskContractHash'));
  // Empty inputs are a standalone task: the contract hash still pins its own
  // scope, and every related note pins through its digest when present.
  if (!Array.isArray(input.inputs)) {
    errors.push(diag('SCHEMA_INVALID', 'inputs must be an array', 'inputs'));
  }
  if (input.closeout !== 'commit-required' && input.closeout !== 'working-tree-authorized') {
    errors.push(diag('SCHEMA_INVALID', `bad closeout: ${input.closeout}`, 'closeout'));
  }
  if (input.closeout === 'working-tree-authorized' && !input.authorizationRef) {
    errors.push(diag('APPROVAL_REQUIRED', 'working-tree closeout needs an authorization reference upfront', 'authorizationRef'));
  }
  if (input.maxAutoRepairs !== undefined && (!Number.isInteger(input.maxAutoRepairs) || input.maxAutoRepairs < 0)) {
    errors.push(diag('SCHEMA_INVALID', 'maxAutoRepairs must be a non-negative integer', 'maxAutoRepairs'));
  }
  if (errors.length > 0) return fail(null, errors, { runId: '' });
  const at = nowIso();
  const run: HarnessRun = {
    schema: 'harness-run/1',
    runId: newRunId(),
    taskUri: input.taskUri,
    mode: input.mode,
    state: 'queued',
    attempt: 0,
    executor: input.executor ?? 'internal',
    lease: null,
    baseline: { taskContractHash: input.taskContractHash, inputs: input.inputs },
    repairBudget: { maxAuto: input.maxAutoRepairs ?? 1, usedAuto: 0 },
    repairs: [],
    receipts: [],
    takeovers: [],
    closeout: input.closeout,
    ...(input.authorizationRef ? { authorizationRef: input.authorizationRef } : {}),
    createdAt: at,
    updatedAt: at,
  };
  try {
    await saveRun(root, run);
    return pass(run, { runId: run.runId });
  } catch (e) {
    return fail(null, storeError(e, null), { runId: '' });
  }
}

async function withRun<T>(
  root: string,
  runId: string,
  op: (run: HarnessRun) => Promise<OpResult<T>>,
): Promise<OpResult<T>> {
  let run: HarnessRun;
  try {
    run = await loadRun(root, runId);
  } catch (e) {
    return fail(null, storeError(e, null), undefined as T);
  }
  try { return await op(run); }
  catch (error) { return fail(run, storeError(error, run), undefined as T); }
}

function leaseMismatch(run: HarnessRun, token: string): Diagnostic[] {
  if (!run.lease || run.lease.token !== token) {
    const holder = run.lease ? `held by ${run.lease.owner}` : 'no lease held';
    return [diag('BUSY', `lease mismatch (${holder}); re-claim or take over explicitly`, 'lease')];
  }
  return [];
}

export async function startRun(
  root: string,
  runId: string,
  owner: string,
  preconditions: StartPreconditions,
): Promise<OpResult<{ attempt: number }>> {
  return withRun(root, runId, async (run) => {
    const claim = await acquireLease(root, runId, owner).catch((e: unknown) => ({ acquired: false as const, holder: null, error: e }));
    if (!claim.acquired) {
      const holder = 'holder' in claim && claim.holder ? `held by ${claim.holder.owner}` : 'lease unavailable';
      return fail(run, [diag('BUSY', `another owner holds this run (${holder})`, 'lease')], { attempt: run.attempt });
    }
    const problems = checkedState(run, 'start', {
      ...idleCtx(),
      baselineValid: preconditions.baselineValid,
      dependenciesReady: preconditions.dependenciesReady,
      authorized: preconditions.authorization !== null,
    });
    if (problems.length > 0) {
      await releaseLease(root, runId, claim.lease.token);
      return fail(run, problems, { attempt: run.attempt });
    }
    run.lease = claim.lease;
    run.attempt = nextAttempt({ attempt: run.attempt } as TaskExecution, 'start');
    run.state = 'running';
    if (preconditions.authorization?.ref && !run.authorizationRef) run.authorizationRef = preconditions.authorization.ref;
    try {
      await saveRun(root, run);
      return pass(run, { attempt: run.attempt });
    } catch (e) {
      await releaseLease(root, runId, claim.lease.token);
      return fail(run, storeError(e, run), { attempt: run.attempt });
    }
  });
}

export async function verifyRun(
  root: string,
  runId: string,
  token: string,
  codeManifest: CodeRow[],
): Promise<OpResult<undefined>> {
  return withRun(root, runId, async (run) => {
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, undefined);
    const problems = checkedState(run, 'verify', idleCtx());
    if (problems.length > 0) return fail(run, problems, undefined);
    run.verification = { codeManifest, recordedAt: nowIso() };
    run.state = 'verifying';
    try {
      await saveRun(root, run);
      return pass(run, undefined);
    } catch (e) {
      return fail(run, storeError(e, run), undefined);
    }
  });
}

export async function recordReceipt(
  root: string,
  runId: string,
  token: string,
  receipt: Receipt,
): Promise<OpResult<{ receiptId: string }>> {
  return withRun(root, runId, async (run) => {
    const shape = validateReceiptShape(receipt);
    if (shape.length) return fail(run, shape, { receiptId: '' });
    if (run.receipts.includes(receipt.id)) {
      const stored = await loadReceipt(root, runId, receipt.id);
      return receiptContentHash(stored) === receiptContentHash(receipt) ? pass(run, { receiptId: receipt.id })
        : fail(run, [diag('CONFLICT', `receipt ${receipt.id} already exists with different content`)], { receiptId: '' });
    }
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, { receiptId: '' });
    const problems = validateReceiptShape(receipt);
    if (problems.length > 0) return fail(run, problems, { receiptId: '' });
    if (run.state !== 'verifying') {
      problems.push(diag('NOT_READY', `record receipts only while verifying (now ${run.state})`, 'state'));
    }
    if (receipt.taskUri !== run.taskUri) {
      problems.push(diag('SCHEMA_INVALID', `receipt targets ${receipt.taskUri}, run owns ${run.taskUri}`, 'taskUri'));
    }
    if (receipt.taskContractHash !== run.baseline.taskContractHash) {
      problems.push(diag('STALE_BASELINE', 'receipt pins a different contract than this run', 'taskContractHash'));
    }
    if (inputKey(receipt.inputs) !== inputKey(run.baseline.inputs)) problems.push(diag('STALE_BASELINE', 'receipt inputs differ from the pinned run inputs', 'inputs'));
    if (receipt.mode !== run.mode) {
      problems.push(diag('SCHEMA_INVALID', `receipt mode ${receipt.mode} differs from run mode ${run.mode}`, 'mode'));
    }
    if (receipt.attempt !== run.attempt) {
      problems.push(diag('STALE_BASELINE', `receipt attempt ${receipt.attempt} is not the live attempt ${run.attempt}`, 'attempt'));
    }
    if (problems.length > 0) return fail(run, problems, { receiptId: '' });
    if (!run.receipts.includes(receipt.id)) run.receipts.push(receipt.id);
    try {
      await saveRun(root, run, receipt);
      return pass(run, { receiptId: receipt.id });
    } catch (e) {
      return fail(run, storeError(e, run), { receiptId: '' });
    }
  });
}

export async function finishRun(
  root: string,
  runId: string,
  token: string,
  receiptId: string,
  live: LiveSnapshot,
): Promise<OpResult<{ receiptId: string }>> {
  return withRun(root, runId, async (run) => {
    if (run.state === 'done' && run.completedReceiptId === receiptId) {
      const result = await readTaskResult(root, run.taskUri, { receiptId });
      return result.validity === 'valid' ? pass(run, { receiptId }) : fail(run, result.errors, { receiptId });
    }
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, { receiptId });
    let receipt: Receipt;
    try {
      receipt = await loadReceipt(root, runId, receiptId);
    } catch (e) {
      return fail(run, storeError(e, run), { receiptId });
    }
    const problems = checkedState(run, 'finish', { ...idleCtx(), receiptReady: run.receipts.includes(receiptId) });
    const shapeProblems = validateReceiptShape(receipt);
    if (shapeProblems.length > 0) return fail(run, shapeProblems, { receiptId });
    if (receipt.taskUri !== run.taskUri || receipt.taskContractHash !== run.baseline.taskContractHash || receipt.attempt !== run.attempt || receipt.mode !== run.mode || inputKey(receipt.inputs) !== inputKey(run.baseline.inputs)) {
      problems.push(diag('STALE_BASELINE', 'receipt does not belong to this run baseline and attempt', 'receipts'));
    }
    if (!run.verification || manifestKey(receipt.codeManifest) !== manifestKey(run.verification.codeManifest)) {
      problems.push(diag('STALE_BASELINE', 'receipt manifest differs from the files pinned at verify', 'codeManifest'));
    }
    problems.push(...evaluateReceipt(receipt, toValidityContext(live)));
    if (problems.length > 0) return fail(run, problems, { receiptId });
    run.state = 'done';
    run.completedReceiptId = receiptId;
    run.lease = null;
    try {
      await saveRun(root, run);
    } catch (e) {
      return fail(run, storeError(e, run), { receiptId });
    }
    return pass(run, { receiptId });
  });
}

export async function repairRun(
  root: string,
  runId: string,
  token: string,
  packet: RepairPacket,
): Promise<OpResult<{ attempt: number }>> {
  return withRun(root, runId, async (run) => {
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, { attempt: run.attempt });
    if (!run.receipts.includes(packet.failureReceiptId)) {
      return fail(run, [diag('NOT_FOUND', `failure receipt not on this run: ${packet.failureReceiptId}`, 'failureReceiptId')], { attempt: run.attempt });
    }
    const problems: Diagnostic[] = [];
    if (packet.auto && run.repairBudget.usedAuto >= run.repairBudget.maxAuto) {
      problems.push(diag('BUSY', `automatic repair budget spent (${run.repairBudget.usedAuto}/${run.repairBudget.maxAuto})`, 'repairBudget'));
    }
    if (!packet.auto && !packet.authorization) {
      problems.push(diag('APPROVAL_REQUIRED', 'manual repair needs authorization', 'authorization'));
    }
    problems.push(...checkedState(run, 'repair', {
      ...idleCtx(),
      authorized: !packet.auto ? packet.authorization !== undefined && packet.authorization !== null : true,
      repairBudgetLeft: !packet.auto || run.repairBudget.usedAuto < run.repairBudget.maxAuto,
      baselineValid: true,
    }));
    if (problems.length > 0) return fail(run, problems, { attempt: run.attempt });
    run.attempt = nextAttempt({ attempt: run.attempt } as TaskExecution, 'repair');
    run.state = 'running';
    if (packet.auto) run.repairBudget.usedAuto += 1;
    const record = {
      attempt: run.attempt,
      auto: packet.auto,
      failureReceiptId: packet.failureReceiptId,
      summary: packet.summary,
      at: nowIso(),
      ...(packet.constraints ? { constraints: packet.constraints } : {}),
    };
    try {
      await storeRepairPacket(root, runId, record);
      run.repairs.push({ attempt: record.attempt, auto: record.auto, failureReceiptId: record.failureReceiptId, summary: record.summary, at: record.at });
      await saveRun(root, run);
      return pass(run, { attempt: run.attempt });
    } catch (e) {
      return fail(run, storeError(e, run), { attempt: run.attempt });
    }
  });
}

export interface AutoRepairOutcome {
  repaired: boolean;
  attempt?: number;
  reason?: 'wrong-state' | 'no-failed-checks' | 'stale-receipt' | 'budget-spent';
}

/**
 * Automatic repair scheduling (T3). Spends the run's automatic budget when
 * the live attempt recorded a receipt with failed required checks and the
 * host asks what to do next, instead of leaving the failure for a human
 * to notice. The summary names the failed checks so the next attempt
 * inherits the failure context through the standard repair packet; mode
 * gates (self/independent review, finish validity) still apply downstream.
 * Skips without touching the run when there is nothing to repair, the
 * evidence belongs to an older attempt, or the budget is spent — manual
 * repair stays available in those cases. Loop safety comes from budget
 * accounting plus the attempt match: every new failure records a new
 * receipt, so retriggering always needs fresh evidence.
 */
// Note: automatic repair spends the budget here — see .agents/notes/implemented/architecture/2026-09-19-harness-auto-repair.md
export async function maybeAutoRepair(
  root: string,
  runId: string,
  token: string,
): Promise<OpResult<AutoRepairOutcome>> {
  return withRun<AutoRepairOutcome>(root, runId, async (run) => {
    if (run.state !== 'verifying') {
      return pass(run, { repaired: false, reason: 'wrong-state' });
    }
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, { repaired: false });
    const latestId = run.receipts.at(-1);
    if (!latestId) return pass(run, { repaired: false, reason: 'no-failed-checks' });
    let receipt: Receipt;
    try {
      receipt = await loadReceipt(root, runId, latestId);
    } catch (e) {
      return fail(run, storeError(e, run), { repaired: false });
    }
    if (receipt.attempt !== run.attempt) {
      return pass(run, { repaired: false, reason: 'stale-receipt' });
    }
    const failed = receipt.checks.filter((check) => check.required && check.status === 'failed');
    if (failed.length === 0) {
      return pass(run, { repaired: false, reason: 'no-failed-checks' });
    }
    if (run.repairBudget.usedAuto >= run.repairBudget.maxAuto) {
      return pass(run, { repaired: false, reason: 'budget-spent' });
    }
    const summary = `Auto repair (attempt ${run.attempt + 1}): required checks failed [${failed.map((check) => check.id).join(', ')}]: ${(failed[0].summary ?? '').slice(0, 240)}`;
    const repaired = await repairRun(root, runId, token, { failureReceiptId: latestId, summary, auto: true });
    if (!repaired.ok) return fail(repaired.run, repaired.errors, { repaired: false });
    return pass(repaired.run as HarnessRun, { repaired: true, attempt: repaired.data.attempt });
  });
}

export async function pauseRun(root: string, runId: string, token: string): Promise<OpResult<undefined>> {  return withRun(root, runId, async (run) => {
    const leaseProblems = run.state === 'queued' ? [] : leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, undefined);
    const problems = checkedState(run, 'pause', idleCtx());
    if (problems.length > 0) return fail(run, problems, undefined);
    run.pausedFrom = run.state;
    run.state = 'paused';
    try {
      await saveRun(root, run);
      return pass(run, undefined);
    } catch (e) {
      return fail(run, storeError(e, run), undefined);
    }
  });
}

export async function resumeRun(root: string, runId: string, token: string): Promise<OpResult<{ state: ExecutionState }>> {
  return withRun(root, runId, async (run) => {
    if (run.state !== 'paused') {
      return fail(run, checkedState(run, 'resume', idleCtx()), { state: run.state });
    }
    const lease = await readLease(root, runId);
    const held = lease !== null && lease.token === token;
    const problems = checkedState(run, 'resume', { ...idleCtx(), leaseHeld: held });
    if (problems.length > 0) return fail(run, problems, { state: run.state });
    const backTo = run.pausedFrom ?? (run.attempt === 0 ? 'queued' : 'running');
    run.state = backTo;
    run.lease = lease;
    try {
      await saveRun(root, run);
      return pass(run, { state: backTo });
    } catch (e) {
      return fail(run, storeError(e, run), { state: run.state });
    }
  });
}

export async function rebaselineRun(
  root: string,
  runId: string,
  token: string,
  baseline: { taskContractHash: string; inputs: BaselineInput[] },
  authorization: { by: string; ref?: string } | null,
): Promise<OpResult<undefined>> {
  return withRun(root, runId, async (run) => {
    const leaseProblems = leaseMismatch(run, token);
    if (leaseProblems.length > 0) return fail(run, leaseProblems, undefined);
    const problems: Diagnostic[] = [];
    if (!HEX64_RE.test(baseline.taskContractHash)) {
      problems.push(diag('SCHEMA_INVALID', 'task contract hash must be hex64', 'taskContractHash'));
    }
    if (!Array.isArray(baseline.inputs)) {
      problems.push(diag('NOT_READY', 'rebaseline needs an inputs array', 'inputs'));
    }
    problems.push(...checkedState(run, 'rebaseline', { ...idleCtx(), authorized: authorization !== null }));
    if (problems.length > 0) return fail(run, problems, undefined);
    run.baseline = { taskContractHash: baseline.taskContractHash, inputs: baseline.inputs };
    run.verification = undefined;
    run.state = 'queued';
    run.lease = null;
    delete run.pausedFrom;
    if (authorization?.ref && !run.authorizationRef) run.authorizationRef = authorization.ref;
    try {
      await saveRun(root, run);
      return pass(run, undefined);
    } catch (e) {
      return fail(run, storeError(e, run), undefined);
    }
  });
}

export async function cancelRun(root: string, runId: string, token: string | null): Promise<OpResult<undefined>> {
  return withRun(root, runId, async (run) => {
    if (token !== null) {
      const leaseProblems = leaseMismatch(run, token);
      if (leaseProblems.length > 0) return fail(run, leaseProblems, undefined);
    }
    const problems = checkedState(run, 'cancel', idleCtx());
    if (problems.length > 0) return fail(run, problems, undefined);
    run.state = 'cancelled';
    run.lease = null;
    try {
      await saveRun(root, run);
    } catch (e) {
      return fail(run, storeError(e, run), undefined);
    }
    return pass(run, undefined);
  });
}

export async function markRun(
  root: string,
  runId: string,
  kind: 'stale' | 'restart',
  summary: string,
): Promise<OpResult<undefined>> {
  return withRun(root, runId, async (run) => {
    const problems = checkedState(run, kind, idleCtx());
    if (problems.length > 0) return fail(run, problems, undefined);
    run.state = 'blocked';
    run.blocker = { code: kind === 'stale' ? 'STALE_BASELINE' : 'RESTART', summary };
    try {
      await saveRun(root, run);
      return pass(run, undefined);
    } catch (e) {
      return fail(run, storeError(e, run), undefined);
    }
  });
}

/** Explicit ownership handoff. Never automatic: the previous owner, the new
 * owner, and the reason all land in the record. Paused runs qualify: losing
 * the lease file (crash, deleted checkout state) must not strand a run that
 * can only continue after an explicit re-claim. */
export async function takeoverRun(
  root: string,
  runId: string,
  newOwner: string,
  reason: string,
): Promise<OpResult<{ token: string }>> {
  return withRun(root, runId, async (run) => {
    if (run.state !== 'running' && run.state !== 'verifying' && run.state !== 'paused') {
      return fail(run, [diag('SCHEMA_INVALID', `takeover needs an owned run (now ${run.state})`, 'state')], { token: '' });
    }
    if (!reason.trim()) return fail(run, [diag('SCHEMA_INVALID', 'takeover needs a reason', 'reason')], { token: '' });
    const from = run.lease ? run.lease.owner : 'none';
    await releaseLease(root, runId, run.lease?.token);
    const claim = await acquireLease(root, runId, newOwner).catch((e: unknown) => ({ acquired: false as const, holder: null, error: e }));
    if (!claim.acquired) {
      return fail(run, [diag('BUSY', 'lost the lease race during takeover; retry explicitly', 'lease')], { token: '' });
    }
    run.takeovers.push({ from, to: newOwner, reason, at: nowIso() });
    run.lease = claim.lease;
    try {
      await saveRun(root, run);
      return pass(run, { token: claim.lease.token });
    } catch (e) {
      return fail(run, storeError(e, run), { token: '' });
    }
  });
}

export async function closeoutRun(root: string, runId: string, check: CloseoutCheck): Promise<OpResult<CloseoutReport>> {
  return withRun<CloseoutReport>(root, runId, async (run) => {
    if (run.state !== 'done' || !run.completedReceiptId) {
      return fail(run, [diag('NOT_READY', 'closeout requires a successfully verified run', 'state')], {
        strategy: run.closeout, satisfied: false, worktreeMatches: false, detail: 'run has not completed verification',
      });
    }
    const result = await readTaskResult(check.repoRoot, run.taskUri, { closeout: true, receiptId: run.completedReceiptId });
    if (!result.validReceipts.includes(run.completedReceiptId)) return pass(run, {
      strategy: run.closeout, satisfied: false, worktreeMatches: false,
      detail: result.errors.map((error) => error.message).join('; ') || 'the completed receipt is not currently valid',
    });
    return pass(run, result.closeout ?? { strategy: run.closeout, satisfied: false, worktreeMatches: false, detail: 'formal result is unavailable' });
  });
}

export async function handoffRun(root: string, runId: string): Promise<OpResult<{ path: string }>> {
  return withRun(root, runId, async (run) => {
    try {
      const path = await writeHandoff(root, run);
      return pass(run, { path });
    } catch (e) {
      return fail(run, storeError(e, run), { path: '' });
    }
  });
}
