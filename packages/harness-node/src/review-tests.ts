// Note: evaluator-owned tests reuse fixed receipts — see .agents/notes/harness/workflowx-v2-adoption.md
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { isIndependentReviewPath, parseReviewTestPlan, type Receipt, type ReceiptCheck, type RunReviewTests, type VerificationStep } from '@janus-agent/harness-core';
import { TaskScope } from './task-scope.js';
import { sha256HexBytes } from './repository.js';

export interface ReviewCommandResult { ok: boolean; exitCode?: number; timedOut?: boolean; summary: string }
export interface ReviewTestSessionInput {
  root: string;
  repoId: string;
  actor: string;
  manifest: Receipt['codeManifest'];
  criteria: Pick<Receipt['coverage'][number], 'uri' | 'criterionId'>[];
  verification: VerificationStep[];
  command?: (step: VerificationStep, signal?: AbortSignal) => Promise<ReviewCommandResult>;
  checkCurrent?: () => Promise<unknown>;
}

/** Model code receives only copied, hash-checked source; write permission is limited to disposable fixtures. */
async function runNodeTest(input: ReviewTestSessionInput, source: string, signal?: AbortSignal): Promise<ReviewCommandResult> {
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(tmpdir(), 'wfx-evaluation-'));
  const sources = join(temporary, 'source'), scratch = join(temporary, 'tmp');
  const scope = new TaskScope(input.root, input.repoId, { scope: [{ repoId: input.repoId, paths: ['.'] }], acceptanceRefs: [], verification: [] });
  try {
    await mkdir(sources); await mkdir(scratch);
    let bytes = 0;
    for (const file of input.manifest) {
      signal?.throwIfAborted();
      if (file.repoId !== input.repoId || !isIndependentReviewPath(file.path)) throw new Error('CAPABILITY_UNAVAILABLE: evaluator source must belong to this checkout and exclude histories');
      await scope.checkPath(file.path);
      if (file.deleted) continue;
      const body = await readFile(join(input.root, file.path));
      if (sha256HexBytes(body) !== file.sha256) throw new Error('STALE_BASELINE: evaluator source changed: ' + file.path);
      bytes += body.length;
      if (bytes > 64 * 1024 * 1024) throw new Error('CAPABILITY_UNAVAILABLE: evaluator source exceeds 64 MiB; select a declared test command');
      const destination = resolve(sources, file.path);
      if (relative(sources, destination).startsWith('..')) throw new Error('SCHEMA_INVALID: evaluator source path escapes its copy');
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body);
    }
    // Never inherit NODE_OPTIONS, credentials, or application session environment into generated tests.
    const env: NodeJS.ProcessEnv = { WFX_TEST_TMP: scratch, ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    return await new Promise<ReviewCommandResult>((done, reject) => {
      let output = '', timedOut = false;
      const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
      const child = spawn(process.execPath, [permission, `--allow-fs-read=${sources}`, `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, '--input-type=module', '--eval', source], { cwd: sources, env, windowsHide: true, shell: false });
      const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-16000); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const cancel = () => { child.kill(); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.on('error', error => { clean(); reject(error); });
      child.on('close', exitCode => {
        clean();
        if (signal?.aborted) { reject(signal.reason ?? new Error('Evaluation aborted')); return; }
        done({ ok: exitCode === 0 && !timedOut, ...(exitCode === null ? {} : { exitCode }), timedOut, summary: output.trim() || (timedOut ? 'Test timed out' : 'Node test completed') });
      });
    });
  } finally {
    // mkdtemp returns a fresh absolute child of the named temp directory.
    if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(tmpdir(), 'wfx-evaluation-'))) throw new Error('Refusing unexpected evaluation cleanup path');
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Each review gets one host-owned test phase. Callers append only these observed checks to receipts. */
export function createReviewTestSession(input: ReviewTestSessionInput): { run: RunReviewTests; checks: ReceiptCheck[]; assertExecuted(): void } {
  let started = false, completed = false;
  const checks: ReceiptCheck[] = [];
  return {
    checks,
    assertExecuted() { if (!completed) throw new Error('NOT_READY: independent evaluator must execute its test plan before returning a verdict'); },
    async run(raw, signal) {
      if (started) throw new Error('NOT_READY: evaluator test plan already executed');
      const plan = parseReviewTestPlan(raw, input.criteria);
      started = true;
      await input.checkCurrent?.();
      if (!plan.tests.length) {
        checks.push({ id: 'eval-' + randomUUID(), kind: 'manual', required: true, repoId: input.repoId, status: 'not-run', summary: plan.blocker!.slice(0, 16000), performedBy: input.actor });
      }
      for (const test of plan.tests) {
        signal?.throwIfAborted();
        await input.checkCurrent?.();
        const step = test.checkId ? input.verification.find(row => row.id === test.checkId) : undefined;
        if (test.checkId && (!step || step.kind !== 'command' || step.repoId !== input.repoId)) throw new Error('CAPABILITY_UNAVAILABLE: evaluator may rerun only declared commands for this checkout');
        const command = step ? { program: step.program!, args: [...(step.args ?? [])], cwd: step.cwd } : { program: 'node', args: ['--input-type=module', '--eval', test.source!], cwd: '.' };
        let result: ReviewCommandResult;
        try {
          if (step && !input.command) throw new Error('CAPABILITY_UNAVAILABLE: evaluator command runner missing');
          if (step) await new TaskScope(input.root, input.repoId, { scope: [{ repoId: input.repoId, paths: ['.'] }], acceptanceRefs: [], verification: [] }).checkPath(step.cwd);
          result = step ? await input.command!(structuredClone(step), signal) : await runNodeTest(input, test.source!, signal);
        } catch (error) {
          if (signal?.aborted || String(error).includes('STALE_BASELINE')) throw error;
          checks.push({ id: 'eval-' + randomUUID(), kind: 'command', required: true, repoId: input.repoId, command, status: 'not-run', summary: `${test.name}: ${String(error)}`.slice(0, 16000), performedBy: input.actor });
          continue;
        }
        const unavailable = /ERR_ACCESS_DENIED|bad option:|unknown option|not allowed in NODE_OPTIONS/.test(result.summary);
        checks.push({ id: 'eval-' + randomUUID(), kind: 'command', required: true, repoId: input.repoId, command,
          status: unavailable ? 'not-run' : result.ok && result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
          ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
          summary: `${test.name} (${test.criteria.map(ref => `${ref.uri}#${ref.criterionId}`).join(', ')}): ${result.summary}`.slice(0, 16000), performedBy: input.actor });
      }
      signal?.throwIfAborted();
      await input.checkCurrent?.();
      completed = true;
      return structuredClone(checks);
    },
  };
}
