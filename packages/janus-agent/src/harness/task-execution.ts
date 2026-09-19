// Note: task turns and verification share one host lifecycle - see .agents/notes/implemented/architecture/2026-09-18-harness-task-execution.md
import { randomUUID } from 'node:crypto';
import { codeKey, codeManifestHash, INDEPENDENT_REVIEW_TOOLS, isIndependentReviewPath, taskExecutionPolicy, validateReceiptShape, type Receipt, type ReceiptCheck, type VerificationStep } from '@janus-agent/harness-core';
import { collectLiveSnapshot, collectTaskSnapshot, TaskScope } from '@janus-agent/harness-node';
import { finishRun, maybeAutoRepair, pauseRun, recordReceipt, verifyRun } from './dispatcher.js';
import { loadReceipt, loadRun, readLease, type HarnessRun } from './run-store.js';
import type { ChatTurnRequest } from '../orchestrator/chat-turn.js';

const READ_TOOLS = ['workspace.read', 'workspace.list', 'workspace.search', 'git.status', 'git.diff', 'git.log'];
const WRITE_TOOLS = ['workspace.edit', 'workspace.create', 'workspace.delete'];
const normalized = (name: string) => name.toLowerCase().replace(/[._-]/g, '');
const inputKey = (inputs: HarnessRun['baseline']['inputs']) => JSON.stringify(inputs.map((row) => [row.uri, row.contentHash, [...(row.criteria ?? [])].sort()]).sort());

export const taskManifestHash = codeManifestHash;

async function context(root: string, runId: string, token: string, states: string[]) {
  const run = await loadRun(root, runId);
  const lease = await readLease(root, runId);
  if (!lease || lease.token !== token || run.lease?.token !== token) throw new Error('BUSY: task lease changed');
  if (!states.includes(run.state)) throw new Error(`NOT_READY: task is ${run.state}`);
  if (run.executor !== 'internal') throw new Error('CAPABILITY_UNAVAILABLE: external runs need their own execution host');
  const snapshot = await collectTaskSnapshot(root, run.taskUri);
  if (!snapshot.ok) throw new Error(snapshot.errors.map((error) => `${error.code}: ${error.message}`).join('\n'));
  if (snapshot.baseline.taskContractHash !== run.baseline.taskContractHash || inputKey(snapshot.baseline.inputs) !== inputKey(run.baseline.inputs)) throw new Error('STALE_BASELINE: task contract or inputs changed; rebaseline explicitly');
  return { run, snapshot, scope: new TaskScope(root, snapshot.repoId, snapshot.work) };
}

export interface TaskTurnContext extends Pick<ChatTurnRequest, 'sourceTag' | 'systemPromptPrefix' | 'toolAllowlist' | 'toolGate'> {
  root: string;
  conversationId: string;
}

/** No shell, process, delegation, or ledger mutations in model-directed turns. */
export async function prepareTaskTurn(root: string, runId: string, token: string, readOnly = false, independent = false): Promise<TaskTurnContext> {
  const states = readOnly ? ['verifying'] : ['running'];
  const { run, snapshot, scope } = await context(root, runId, token, states);
  const policy = taskExecutionPolicy(run.mode, run.lease!.owner, runId);
  const repair = independent ? undefined : run.repairs.find((row) => row.attempt === run.attempt);
  const failureReceipt = repair ? await loadReceipt(root, runId, repair.failureReceiptId) : undefined;
  const tools = independent ? INDEPENDENT_REVIEW_TOOLS : [...READ_TOOLS, ...(readOnly ? [] : [...WRITE_TOOLS, 'todo_write', 'ask_user'])];
  return {
    root,
    conversationId: `harness-${runId}-${run.attempt}${readOnly ? '-review' : ''}`,
    sourceTag: 'harness',
    systemPromptPrefix: [
      'Task-bound execution. Follow the pinned task contract below. Report blockers explicitly.',
      'Only the host can verify or complete this task. Model prose never changes run state.',
      'File mutations are restricted to literal scope paths. Ledger writes and arbitrary commands are unavailable.',
      `Workflow ${run.mode}. ${readOnly ? 'Review only; independently inspect the current files and evidence.' : `Implementor identity: ${policy.implementor}. Complete the accepted task within its scope.`}`,
      JSON.stringify({ taskUri: run.taskUri, baseline: run.baseline, work: snapshot.work, notes: snapshot.notes, repair, failureReceipt }),
    ].join('\n'),
    toolAllowlist: tools,
    toolGate: async (call) => {
      try {
        const current = await context(root, runId, token, states);
        if (current.run.attempt !== run.attempt) throw new Error('STALE_BASELINE: task attempt changed');
        const name = normalized(call.name);
        if (!tools.some((tool) => normalized(tool) === name)) throw new Error(`CAPABILITY_UNAVAILABLE: task tool ${call.name}`);
        const args = call.arguments && typeof call.arguments === 'object' ? call.arguments as Record<string, unknown> : {};
        const mutation = WRITE_TOOLS.some((tool) => normalized(tool) === name);
        if (independent && (typeof args.path !== 'string' || !isIndependentReviewPath(args.path))) throw new Error('CAPABILITY_UNAVAILABLE: evaluator cannot read task histories or ledgers');
        if (mutation && typeof args.path !== 'string') throw new Error('SCHEMA_INVALID: file mutation needs path');
        if (name.startsWith('workspace') && typeof args.path === 'string') await scope.checkPath(args.path, mutation);
        return undefined;
      } catch (error) {
        return { block: true, terminate: true, reason: String(error) };
      }
    },
  };
}

export interface TaskVerificationPorts {
  command?: (step: VerificationStep, signal?: AbortSignal) => Promise<{ ok: boolean; exitCode?: number; timedOut?: boolean; summary: string }>;
  review?: (input: { turn: TaskTurnContext; actor: string; kind: 'self' | 'independent'; manifest: Receipt['codeManifest']; manifestHash: string; checks: ReceiptCheck[]; criteria: Receipt['coverage'] }, signal?: AbortSignal) => Promise<Pick<Receipt, 'review' | 'coverage'>>;
  independentReview?: TaskVerificationPorts['review'];
}

/** Host executes declared checks; reviewers provide structured, version-bound evidence. */
export async function verifyTaskExecution(root: string, runId: string, token: string, ports: TaskVerificationPorts, signal?: AbortSignal): Promise<{ receipt: Receipt; completed: boolean; errors: string[] }> {
  const { run, snapshot, scope } = await context(root, runId, token, ['running', 'verifying']);
  const policy = taskExecutionPolicy(run.mode, run.lease!.owner, runId);
  if (!ports.review) throw new Error('CAPABILITY_UNAVAILABLE: task reviewer is unavailable');
  if (policy.independent && !ports.independentReview) throw new Error('CAPABILITY_UNAVAILABLE: xflow requires an independent reviewer');
  if (snapshot.work.verification.some((step) => step.kind !== 'command' || step.repoId !== snapshot.repoId) || !ports.command) throw new Error('CAPABILITY_UNAVAILABLE: verification needs a command runner for this checkout; manual checks need external evidence');
  const manifest = await scope.manifest();
  const manifestHash = taskManifestHash(manifest);
  if (run.state === 'verifying' && (!run.verification || taskManifestHash(run.verification.codeManifest) !== manifestHash)) throw new Error('STALE_BASELINE: code changed after verification; repair before retrying');
  signal?.throwIfAborted();
  if (run.state === 'running') {
    const verified = await verifyRun(root, runId, token, manifest);
    if (!verified.ok) throw new Error(verified.errors.map((error) => `${error.code}: ${error.message}`).join('\n'));
  }
  try {
    const checks: ReceiptCheck[] = [];
    for (const step of snapshot.work.verification) {
      signal?.throwIfAborted();
      await context(root, runId, token, ['verifying']);
      await scope.checkPath(step.cwd);
      const result = await ports.command!(step, signal);
      checks.push({ id: step.id, kind: step.kind, required: step.required, repoId: step.repoId,
        command: { program: step.program!, args: step.args!, cwd: step.cwd },
        status: result.ok && result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        summary: result.summary || 'Command produced no output', performedBy: policy.implementor });
    }
    signal?.throwIfAborted();
    const criteria: Receipt['coverage'] = snapshot.work.acceptanceRefs.map((ref) => ({ ...ref,
      criterionHash: snapshot.criterionHashes.find(([uri]) => uri === ref.uri)![1].find(([id]) => id === ref.criterionId)![1], checkIds: [] }));
    const review = async (port: NonNullable<TaskVerificationPorts['review']>, kind: 'self' | 'independent', actor: string) => {
      const turn = await prepareTaskTurn(root, runId, token, true, kind === 'independent');
      // Every review starts empty, including retries of the same attempt.
      turn.conversationId += `-${kind}-${randomUUID()}`;
      const claim = await port({ turn, actor, kind, manifest, manifestHash, checks, criteria }, signal);
      signal?.throwIfAborted();
      if (claim?.review?.reviewedManifestHash !== manifestHash || claim.review?.kind !== kind || claim.review?.actor !== actor) throw new Error('NOT_READY: review must bind the tested manifest and assigned reviewer identity');
      const problems = validateReceiptShape({ schema: 'harness-receipt/1', id: 'review-shape', taskUri: run.taskUri, mode: kind === 'self' ? 'xdel' : 'xflow', attempt: run.attempt,
        taskContractHash: run.baseline.taskContractHash, inputs: run.baseline.inputs, codeManifest: manifest, checks, coverage: claim.coverage, review: claim.review, actor: policy.implementor, createdAt: new Date().toISOString() });
      if (problems.length) throw new Error(`SCHEMA_INVALID: ${problems[0].message}`);
      return claim;
    };
    const self = await review(ports.review, 'self', policy.implementor);
    const reviewed = policy.independent ? await review(ports.independentReview!, 'independent', policy.reviewer) : self;
    const receipt: Receipt = { schema: 'harness-receipt/1', id: randomUUID(), taskUri: run.taskUri, mode: run.mode, attempt: run.attempt,
      taskContractHash: run.baseline.taskContractHash, inputs: run.baseline.inputs, codeManifest: manifest,
      checks, coverage: reviewed.coverage, review: reviewed.review, createdAt: new Date().toISOString(), actor: policy.implementor };
    const currentManifest = await scope.manifest();
    const codeChanged = taskManifestHash(currentManifest) !== manifestHash;
    // Failed runs can still supply dependency receipts; drift must invalidate the evidence itself.
    if (codeChanged) receipt.review = { ...receipt.review, verdict: 'blocked' };
    await context(root, runId, token, ['verifying']);
    signal?.throwIfAborted();
    const stored = await recordReceipt(root, runId, token, receipt);
    if (!stored.ok) throw new Error(stored.errors.map((error) => `${error.code}: ${error.message}`).join('\n'));
    if (codeChanged) return { receipt, completed: false, errors: ['STALE_BASELINE: scoped code changed during verification or review'] };
    const live = await collectLiveSnapshot(root, run.taskUri, policy.implementor, currentManifest.map((row) => [codeKey(row.repoId, row.path), row.deleted ? null : row.sha256!]));
    if (!live.ok) return { receipt, completed: false, errors: live.errors.map((error) => `${error.code}: ${error.message}`) };
    signal?.throwIfAborted();
    const finished = await finishRun(root, runId, token, receipt.id, live.live);
    return { receipt, completed: finished.ok, errors: finished.errors.map((error) => `${error.code}: ${error.message}`) };
  } catch (error) {
    if (signal?.aborted) await pauseRun(root, runId, token);
    throw error;
  }
}

// Note: delegated execution owns the full bounded lifecycle — see .agents/notes/implemented/architecture/2026-09-19-delegated-task-hosts.md
export async function executeTaskExecution(root: string, runId: string, token: string,
  ports: TaskVerificationPorts & { implement(turn: TaskTurnContext, signal?: AbortSignal): Promise<{ cancelled: boolean; toolTraces?: Array<{ status: string; summary?: string }> }> }, signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof verifyTaskExecution>>> {
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { run } = await context(root, runId, token, ['running', 'verifying']);
      if (!ports.review || (run.mode === 'xflow' && !ports.independentReview)) throw new Error('CAPABILITY_UNAVAILABLE: required task reviewer is unavailable');
      if (run.state === 'running') {
        const result = await ports.implement(await prepareTaskTurn(root, runId, token), signal);
        if (result.cancelled) { await pauseRun(root, runId, token); throw new Error('NOT_READY: implementation cancelled; run paused'); }
        if (result.toolTraces?.some((trace) => trace.status !== 'completed')) throw new Error('NOT_READY: implementation tool failed; verification refused');
        signal?.throwIfAborted();
      }
      const result = await verifyTaskExecution(root, runId, token, ports, signal);
      if (result.completed || run.mode === 'xdel' || result.receipt.review.verdict === 'blocked' || result.errors.some((error) => error.startsWith('STALE_BASELINE'))) return result;
      signal?.throwIfAborted();
      const auto = await maybeAutoRepair(root, runId, token);
      if (!auto.ok || !auto.data.repaired) return result;
    }
  } catch (error) {
    if (signal?.aborted) await pauseRun(root, runId, token);
    throw error;
  }
}
