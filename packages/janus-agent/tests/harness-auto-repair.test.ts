/**
 * Automatic repair scheduling: the kernel spends the repair budget when the
 * live attempt recorded failed required checks. Temp dirs only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dispatchRun,
  maybeAutoRepair,
  recordReceipt,
  repairRun,
  startRun,
  verifyRun,
} from '../src/harness/dispatcher.js';
import { loadRun, readLease } from '../src/harness/run-store.js';
import { criterionHash, parseNote, taskContractHash, type Receipt } from '@janus-agent/harness-core';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const NOTE = '11111111-1111-4111-8111-111111111111';
const TASK = `note://${REPO}/${NOTE}`;
const TASK_TEXT = ['---', 'schema: harness-note/1', `id: ${NOTE}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-09-18',
  'work:', `  scope: [{repoId: ${REPO}, paths: [src/]}]`, `  acceptanceRefs: [{uri: '${TASK}', criterionId: AC-1}]`,
  `  verification: [{id: c1, kind: command, required: true, repoId: ${REPO}, cwd: '.', program: node, args: ['--test']}]`,
  '---', '', '# Test task', '', '## Scope', '', 'Source.', '', '## Acceptance criteria', '', '- [ ] AC-1: source works', '', '## Verification', '', 'Run tests.', '',
].join('\n');
const CONTRACT = taskContractHash(parseNote(TASK_TEXT));
const CRITERION_HASH = criterionHash('- [ ] AC-1: source works');
const CODE_HASH = 'd'.repeat(64);

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-auto-repair-'));
  mkdirSync(join(dir, '.agents', 'notes'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'harness.json'), JSON.stringify({ repoId: REPO }));
  writeFileSync(join(dir, '.agents', 'notes', 'task.md'), TASK_TEXT);
  return dir;
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schema: 'harness-receipt/1',
    id: 'r1',
    taskUri: TASK,
    mode: 'xdo',
    attempt: 1,
    taskContractHash: CONTRACT,
    inputs: [],
    codeManifest: [{ repoId: REPO, path: 'src/a.ts', sha256: CODE_HASH }],
    checks: [{
      id: 'c1', kind: 'command', required: true, status: 'passed',
      repoId: REPO, exitCode: 0, summary: 'tests pass', performedBy: 'coder-1',
      command: { program: 'node', args: ['--test'], cwd: '.' },
    }],
    coverage: [{ uri: TASK, criterionId: 'AC-1', criterionHash: CRITERION_HASH, checkIds: ['c1'] }],
    review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'coder-1' },
    createdAt: new Date().toISOString(),
    actor: 'coder-1',
    ...overrides,
  };
}

function failedReceipt(id: string, attempt: number): Receipt {
  return receipt({
    id,
    attempt,
    checks: [{ id: 'c1', kind: 'command', required: true, status: 'failed', repoId: REPO, exitCode: 1, summary: 'boom', performedBy: 'coder-1' }],
    coverage: [],
  });
}

const AUTH = { baselineValid: true, dependenciesReady: true, authorization: { by: 'owner-1' } };

async function failingRun(dir: string, maxAutoRepairs = 1): Promise<{ runId: string; token: string }> {
  const d = await dispatchRun(dir, {
    taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT,
    inputs: [], closeout: 'commit-required', maxAutoRepairs,
  });
  expect(d.ok).toBe(true);
  const runId = d.data.runId;
  await startRun(dir, runId, 'owner-1', AUTH);
  const token = (await readLease(dir, runId))?.token ?? '';
  await verifyRun(dir, runId, token, []);
  expect((await recordReceipt(dir, runId, token, failedReceipt('r-fail', 1))).ok).toBe(true);
  return { runId, token };
}

describe('automatic repair scheduling', () => {
  it('repairs once on failed required checks and names them in the packet', async () => {
    const dir = root();
    try {
      const { runId, token } = await failingRun(dir);
      const auto = await maybeAutoRepair(dir, runId, token);
      expect(auto.ok).toBe(true);
      expect(auto.data).toMatchObject({ repaired: true, attempt: 2 });
      const run = await loadRun(dir, runId);
      expect(run.state).toBe('running');
      expect(run.repairBudget).toMatchObject({ maxAuto: 1, usedAuto: 1 });
      expect(run.repairs).toHaveLength(1);
      expect(run.repairs[0]).toMatchObject({ attempt: 2, auto: true, failureReceiptId: 'r-fail' });
      expect(run.repairs[0].summary).toContain('c1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at a spent budget and keeps manual repair available', async () => {
    const dir = root();
    try {
      const { runId, token } = await failingRun(dir);
      expect((await maybeAutoRepair(dir, runId, token)).data.repaired).toBe(true);
      await verifyRun(dir, runId, token, []);
      expect((await recordReceipt(dir, runId, token, failedReceipt('r-fail2', 2))).ok).toBe(true);
      const spent = await maybeAutoRepair(dir, runId, token);
      expect(spent.ok).toBe(true);
      expect(spent.data).toMatchObject({ repaired: false, reason: 'budget-spent' });
      const run = await loadRun(dir, runId);
      expect(run.state).toBe('verifying');
      expect(run.repairBudget.usedAuto).toBe(1);
      expect(run.repairs).toHaveLength(1);
      const manual = await repairRun(dir, runId, token, {
        failureReceiptId: 'r-fail2', summary: 'manual fix', auto: false, authorization: { by: 'owner-1' },
      });
      expect(manual.ok).toBe(true);
      expect(manual.data.attempt).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips receipts without failed required checks', async () => {
    const dir = root();
    try {
    const { runId, token } = await failingRun(dir);
    await verifyRun(dir, runId, token, []);
    const run = await loadRun(dir, runId);
      expect(run.state).toBe('verifying');
      const clean = await recordReceipt(dir, runId, token, receipt({ id: 'r-clean', attempt: 1 }));
      expect(clean.ok).toBe(true);
      const skipped = await maybeAutoRepair(dir, runId, token);
      expect(skipped.ok).toBe(true);
      expect(skipped.data).toMatchObject({ repaired: false, reason: 'no-failed-checks' });
      expect((await loadRun(dir, runId)).repairBudget.usedAuto).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips evidence from older attempts', async () => {
    const dir = root();
    try {
      const { runId, token } = await failingRun(dir, 2);
      expect((await maybeAutoRepair(dir, runId, token)).data.repaired).toBe(true);
      await verifyRun(dir, runId, token, []);
      const stale = await maybeAutoRepair(dir, runId, token);
      expect(stale.ok).toBe(true);
      expect(stale.data).toMatchObject({ repaired: false, reason: 'stale-receipt' });
      expect((await loadRun(dir, runId)).repairBudget.usedAuto).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips outside verifying and refuses foreign leases', async () => {
    const dir = root();
    try {
      const d = await dispatchRun(dir, {
        taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT,
        inputs: [], closeout: 'commit-required',
      });
      expect(d.ok).toBe(true);
      const runId = d.data.runId;
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      const idle = await maybeAutoRepair(dir, runId, token);
      expect(idle.ok).toBe(true);
      expect(idle.data).toMatchObject({ repaired: false, reason: 'wrong-state' });
      await verifyRun(dir, runId, token, []);
      expect((await recordReceipt(dir, runId, token, failedReceipt('r-fail', 1))).ok).toBe(true);
      const foreign = await maybeAutoRepair(dir, runId, 'not-our-token');
      expect(foreign.ok).toBe(false);
      expect(foreign.errors.some((e) => e.code === 'BUSY')).toBe(true);
      const run = await loadRun(dir, runId);
      expect(run.state).toBe('verifying');
      expect(run.repairBudget.usedAuto).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
