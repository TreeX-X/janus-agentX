/**
 * Harness dispatch kernel: run records, leases, transitions, repair budget,
 * receipts, handoff, and closeout. Temp dirs only; the git closeout block
 * skips when git is unavailable.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitAvailable, sha256HexBytes } from '@janus-agent/harness-node';
import {
  cancelRun,
  closeoutRun,
  dispatchRun,
  finishRun,
  handoffRun,
  markRun,
  pauseRun,
  rebaselineRun,
  recordReceipt,
  repairRun,
  resumeRun,
  startRun,
  takeoverRun,
  verifyRun,
  type LiveSnapshot,
} from '../src/harness/dispatcher.js';
import { readLease } from '../src/harness/run-store.js';
import type { Receipt } from '@janus-agent/harness-core';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const NOTE = '11111111-1111-4111-8111-111111111111';
const TASK = `note://${REPO}/${NOTE}`;
const CONTRACT = 'a'.repeat(64);
const INPUT_HASH = 'b'.repeat(64);
const CRITERION_HASH = 'c'.repeat(64);
const CODE_HASH = 'd'.repeat(64);

function root(): string {
  return mkdtempSync(join(tmpdir(), 'harness-dispatch-'));
}

function live(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    taskContractHash: CONTRACT,
    inputHashes: [[TASK, INPUT_HASH]],
    criterionHashes: [[TASK, [['AC-1', CRITERION_HASH]]]],
    codeHashes: [[`${REPO} src/a.ts`, CODE_HASH]],
    implementor: 'coder-1',
    ...overrides,
  };
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schema: 'harness-receipt/1',
    id: 'r1',
    taskUri: TASK,
    mode: 'xdo',
    attempt: 1,
    taskContractHash: CONTRACT,
    inputs: [{ uri: TASK, contentHash: INPUT_HASH }],
    codeManifest: [{ repoId: REPO, path: 'src/a.ts', sha256: CODE_HASH }],
    checks: [{
      id: 'c1', kind: 'command', required: true, status: 'passed',
      repoId: REPO, exitCode: 0, summary: 'tests pass', performedBy: 'coder-1',
    }],
    coverage: [{ uri: TASK, criterionId: 'AC-1', criterionHash: CRITERION_HASH, checkIds: ['c1'] }],
    review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'coder-1' },
    createdAt: new Date().toISOString(),
    actor: 'coder-1',
    ...overrides,
  };
}

async function dispatched(dir: string, mode: 'xdo' | 'xdel' | 'xflow' = 'xdo') {
  const d = await dispatchRun(dir, {
    taskUri: TASK,
    mode,
    taskContractHash: CONTRACT,
    inputs: [{ uri: TASK, contentHash: INPUT_HASH }],
    closeout: 'commit-required',
  });
  expect(d.ok).toBe(true);
  return d.data.runId;
}

const AUTH = { baselineValid: true, dependenciesReady: true, authorization: { by: 'owner-1' } };

describe('harness dispatch kernel', () => {
  it('rejects bad dispatch input without writing a run', async () => {
    const dir = root();
    try {
      const bad = await dispatchRun(dir, {
        taskUri: 'nope', mode: 'xdo', taskContractHash: 'zz',
        inputs: [], closeout: 'working-tree-authorized',
      });
      expect(bad.ok).toBe(false);
      expect(bad.errors.map((e) => e.code)).toEqual(
        expect.arrayContaining(['SCHEMA_INVALID', 'NOT_READY', 'APPROVAL_REQUIRED']),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs dispatch to done with lease release and a factual handoff', async () => {
    const dir = root();
    try {
      const runId = await dispatched(dir);
      const s = await startRun(dir, runId, 'owner-1', AUTH);
      expect(s.ok).toBe(true);
      expect(s.data.attempt).toBe(1);
      const token = (await readLease(dir, runId))?.token ?? '';
      expect(token).not.toBe('');
      const v = await verifyRun(dir, runId, token, [{ repoId: REPO, path: 'src/a.ts', sha256: CODE_HASH }]);
      expect(v.ok).toBe(true);
      const r = await recordReceipt(dir, runId, token, receipt());
      expect(r.ok).toBe(true);
      const f = await finishRun(dir, runId, token, 'r1', live());
      expect(f.ok).toBe(true);
      expect(f.run?.state).toBe('done');
      expect(await readLease(dir, runId)).toBeNull();
      const h = await handoffRun(dir, runId);
      expect(h.ok).toBe(true);
      const { readFileSync } = await import('node:fs');
      const md = readFileSync(h.data.path, 'utf8');
      expect(md).toContain(TASK);
      expect(md).toContain(CONTRACT);
      expect(md).toContain('attempt: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an independent review for xflow', async () => {
    const dir = root();
    try {
      const runId = await dispatched(dir, 'xflow');
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      await verifyRun(dir, runId, token, []);
      const self = await recordReceipt(dir, runId, token, receipt({ id: 'r-self', mode: 'xflow', attempt: 1 }));
      expect(self.ok).toBe(false);
      expect(self.errors.some((e) => e.path === 'review')).toBe(true);
      const indie = await recordReceipt(dir, runId, token, receipt({
        id: 'r-indie', mode: 'xflow', attempt: 1,
        review: { kind: 'independent', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'reviewer-9' },
        actor: 'coder-1',
      }));
      expect(indie.ok).toBe(true);
      const f = await finishRun(dir, runId, token, 'r-indie', live());
      expect(f.ok).toBe(true);
      expect(f.run?.state).toBe('done');
      const sameActor = await dispatched(dir, 'xflow');
      await startRun(dir, sameActor, 'owner-1', AUTH);
      const token2 = (await readLease(dir, sameActor))?.token ?? '';
      await verifyRun(dir, sameActor, token2, []);
      await recordReceipt(dir, sameActor, token2, receipt({
        id: 'r-same', mode: 'xflow', attempt: 1,
        review: { kind: 'independent', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'coder-1' },
        actor: 'coder-1',
      }));
      const blocked = await finishRun(dir, sameActor, token2, 'r-same', live());
      expect(blocked.ok).toBe(false);
      expect(blocked.errors.some((e) => e.path === 'review.actor')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('budgets automatic repairs and allows authorized manual repair', async () => {
    const dir = root();
    try {
      const d = await dispatchRun(dir, {
        taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT,
        inputs: [{ uri: TASK, contentHash: INPUT_HASH }],
        closeout: 'commit-required', maxAutoRepairs: 1,
      });
      const runId = d.data.runId;
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      await verifyRun(dir, runId, token, []);
      const failing = receipt({
        id: 'r-fail', attempt: 1,
        checks: [{ id: 'c1', kind: 'command', required: true, status: 'failed', repoId: REPO, exitCode: 1, summary: 'boom', performedBy: 'coder-1' }],
        coverage: [],
      });
      expect((await recordReceipt(dir, runId, token, failing)).ok).toBe(true);
      const rep1 = await repairRun(dir, runId, token, { failureReceiptId: 'r-fail', summary: 'fix it', auto: true });
      expect(rep1.ok).toBe(true);
      expect(rep1.data.attempt).toBe(2);
      await verifyRun(dir, runId, token, []);
      await recordReceipt(dir, runId, token, receipt({ id: 'r-fail2', attempt: 2 }));
      const rep2 = await repairRun(dir, runId, token, { failureReceiptId: 'r-fail2', summary: 'again', auto: true });
      expect(rep2.ok).toBe(false);
      expect(rep2.errors.some((e) => e.code === 'BUSY')).toBe(true);
      const manual = await repairRun(dir, runId, token, {
        failureReceiptId: 'r-fail2', summary: 'manual fix', auto: false, authorization: { by: 'owner-1' },
      });
      expect(manual.ok).toBe(true);
      expect(manual.data.attempt).toBe(3);
      expect(manual.run?.repairBudget.usedAuto).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds one lease per run with explicit takeover only', async () => {
    const dir = root();
    try {
      const runId = await dispatched(dir);
      await startRun(dir, runId, 'owner-1', AUTH);
      const second = await startRun(dir, runId, 'owner-2', AUTH);
      expect(second.ok).toBe(false);
      expect(second.errors.some((e) => e.code === 'BUSY')).toBe(true);
      const token1 = (await readLease(dir, runId))?.token ?? '';
      const taken = await takeoverRun(dir, runId, 'owner-2', 'owner-1 went dark');
      expect(taken.ok).toBe(true);
      expect(taken.run?.takeovers).toHaveLength(1);
      expect((await verifyRun(dir, runId, token1, [])).ok).toBe(false);
      expect((await verifyRun(dir, runId, taken.data.token, [])).ok).toBe(true);
      const idle = await dispatched(dir);
      expect((await takeoverRun(dir, idle, 'owner-2', 'no owner yet')).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses finish on drifted inputs and stays verifying', async () => {
    const dir = root();
    try {
      const runId = await dispatched(dir);
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      await verifyRun(dir, runId, token, []);
      await recordReceipt(dir, runId, token, receipt());
      const drifted = await finishRun(dir, runId, token, 'r1', live({
        codeHashes: [[`${REPO} src/a.ts`, 'f'.repeat(64)]],
      }));
      expect(drifted.ok).toBe(false);
      expect(drifted.errors.some((e) => e.code === 'STALE_BASELINE')).toBe(true);
      expect(drifted.run?.state).toBe('verifying');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks pause, resume, rebaseline, cancel, and terminal guards', async () => {
    const dir = root();
    try {
      const runId = await dispatched(dir);
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      expect((await pauseRun(dir, runId, token)).ok).toBe(true);
      const resumed = await resumeRun(dir, runId, token);
      expect(resumed.ok).toBe(true);
      expect(resumed.data.state).toBe('running');
      expect((await finishRun(dir, runId, token, 'missing', live())).ok).toBe(false);
      const marked = await markRun(dir, runId, 'stale', 'contract moved');
      expect(marked.ok).toBe(true);
      expect(marked.run?.state).toBe('blocked');
      await pauseRun(dir, runId, token);
      const rebase = await rebaselineRun(dir, runId, token,
        { taskContractHash: '9'.repeat(64), inputs: [{ uri: TASK, contentHash: INPUT_HASH }] },
        { by: 'owner-1' });
      expect(rebase.ok).toBe(true);
      expect(rebase.run?.state).toBe('queued');
      expect(rebase.run?.baseline.taskContractHash).toBe('9'.repeat(64));
      expect((await cancelRun(dir, runId, null)).ok).toBe(true);
      expect((await cancelRun(dir, runId, null)).ok).toBe(false);
      const queued = await dispatched(dir);
      expect((await pauseRun(dir, queued, 'no-token')).ok).toBe(true);
      const back = await resumeRun(dir, queued, 'no-token');
      expect(back.ok).toBe(false);
      const reclaimed = await takeoverRun(dir, queued, 'owner-1', 'lease file lost before first start');
      expect(reclaimed.ok).toBe(true);
      const resumedQueued = await resumeRun(dir, queued, reclaimed.data.token);
      expect(resumedQueued.ok).toBe(true);
      expect(resumedQueued.data.state).toBe('queued');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns NOT_FOUND for unknown runs', async () => {
    const dir = root();
    try {
      const s = await startRun(dir, 'nope', 'owner-1', AUTH);
      expect(s.ok).toBe(false);
      expect(s.errors.some((e) => e.code === 'NOT_FOUND')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(gitAvailable(tmpdir()))('harness closeout on git', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }) as string;
  }

  function repoWithContract(): { dir: string; commit: string } {
    const dir = root();
    mkdirSync(join(dir, 'src'), { recursive: true });
    git(dir, 'init');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'seed');
    writeFileSync(join(dir, 'src', 'a.ts'), `// ${CONTRACT}\nexport const a = 1;\n`);
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--no-gpg-sign', '-m', 'land the work');
    const commit = git(dir, 'rev-parse', 'HEAD').trim();
    return { dir, commit };
  }

  it('lands commit-required closeout on the landing commit', async () => {
    const dir = root();
    const repo = repoWithContract();
    try {
      const runId = await dispatched(dir);
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      const sha = sha256HexBytes(readFileSync(join(repo.dir, 'src', 'a.ts')));
      await verifyRun(dir, runId, token, [{ repoId: REPO, path: 'src/a.ts', sha256: sha }]);
      await recordReceipt(dir, runId, token, receipt({
        codeManifest: [{ repoId: REPO, path: 'src/a.ts', sha256: sha }],
      }));
      await finishRun(dir, runId, token, 'r1', live({
        codeHashes: [[`${REPO} src/a.ts`, sha]],
      }));
      const out = await closeoutRun(dir, runId, { repoRoot: repo.dir });
      expect(out.ok).toBe(true);
      expect(out.data.satisfied).toBe(true);
      expect(out.data.commit).toBe(repo.commit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('refuses closeout on drifted worktrees and unlanded hashes', async () => {
    const dir = root();
    const repo = repoWithContract();
    try {
      const runId = await dispatched(dir);
      await startRun(dir, runId, 'owner-1', AUTH);
      const token = (await readLease(dir, runId))?.token ?? '';
      await verifyRun(dir, runId, token, [{ repoId: REPO, path: 'src/a.ts', sha256: CODE_HASH }]);
      await recordReceipt(dir, runId, token, receipt());
      await finishRun(dir, runId, token, 'r1', live());
      const drifted = await closeoutRun(dir, runId, { repoRoot: repo.dir });
      expect(drifted.data.satisfied).toBe(false);
      expect(drifted.data.worktreeMatches).toBe(false);
      const fresh = await dispatched(dir);
      await startRun(dir, fresh, 'owner-1', AUTH);
      const token2 = (await readLease(dir, fresh))?.token ?? '';
      await verifyRun(dir, fresh, token2, [{ repoId: REPO, path: 'src/a.ts', sha256: CODE_HASH }]);
      await recordReceipt(dir, fresh, token2, receipt({ id: 'r9', attempt: 1 }));
      await finishRun(dir, fresh, token2, 'r9', live());
      const empty = repoWithContract();
      try {
        const unlanded = await closeoutRun(dir, fresh, { repoRoot: empty.dir });
        expect(unlanded.data.satisfied).toBe(false);
        expect(unlanded.data.worktreeMatches).toBe(false);
      } finally {
        rmSync(empty.dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('gates working-tree closeout on authorization', async () => {
    const dir = root();
    const repo = repoWithContract();
    try {
      const d = await dispatchRun(dir, {
        taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT,
        inputs: [{ uri: TASK, contentHash: INPUT_HASH }],
        closeout: 'working-tree-authorized', authorizationRef: 'user-said-so',
      });
      await startRun(dir, d.data.runId, 'owner-1', AUTH);
      const token = (await readLease(dir, d.data.runId))?.token ?? '';
      const sha = sha256HexBytes(readFileSync(join(repo.dir, 'src', 'a.ts')));
      await verifyRun(dir, d.data.runId, token, [{ repoId: REPO, path: 'src/a.ts', sha256: sha }]);
      await recordReceipt(dir, d.data.runId, token, receipt({
        codeManifest: [{ repoId: REPO, path: 'src/a.ts', sha256: sha }],
      }));
      await finishRun(dir, d.data.runId, token, 'r1', live({
        codeHashes: [[`${REPO} src/a.ts`, sha]],
      }));
      const out = await closeoutRun(dir, d.data.runId, { repoRoot: repo.dir });
      expect(out.data.satisfied).toBe(true);
      expect(out.data.commit).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
