import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTaskBaseline, runGit } from '@janus-agent/harness-node';
import { dispatchRun, startRun, pauseRun, repairRun, takeoverRun } from '../src/harness/dispatcher.js';
import { loadRun, readLease } from '../src/harness/run-store.js';
import { executeTaskExecution, prepareTaskTurn, verifyTaskExecution, type TaskVerificationPorts } from '../src/harness/task-execution.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const TASK = '55555555-5555-4333-8333-555555555555';
const URI = `note://${REPO}/${TASK}`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(mode: 'xdo' | 'xdel' | 'xflow' = 'xdo', manual = false) {
  const root = await mkdtemp(join(tmpdir(), 'task-execution-'));
  roots.push(root);
  await mkdir(join(root, '.agents', 'notes'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'file.txt'), 'hello');
  await writeFile(join(root, '.agents', 'harness.json'), JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'Test', profile: SUPPORTED_HARNESS_PROFILE }));
  const taskPath = join(root, '.agents', 'notes', '2026-09-18-task--55555555.md');
  await writeFile(taskPath, [
    '---', 'schema: harness-note/1', `id: ${TASK}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-09-18',
    'work:', '  scope:', `    - repoId: ${REPO}`, "      paths: ['src/']", '  acceptanceRefs:', `    - uri: ${URI}`, '      criterionId: AC-1',
    '  verification:', '    - id: check', `      kind: ${manual ? 'manual' : 'command'}`, '      required: true', `      repoId: ${REPO}`, '      cwd: .',
    ...(manual ? ['      description: Inspect it.'] : ['      program: node', "      args: ['-e', 'process.exit(0)']"]),
    '---', '', '# Task', '', '## Scope', '', 'Change the source.', '', '## Acceptance criteria', '', '- [ ] AC-1: source works', '', '## Verification', '', 'Run the check.', '',
  ].join('\n'));
  expect(runGit(root, ['init']).ok).toBe(true);
  expect(runGit(root, ['add', 'src/file.txt']).ok).toBe(true);
  const base = await collectTaskBaseline(root, TASK);
  if (!base.ok) throw new Error(JSON.stringify(base));
  const dispatch = await dispatchRun(root, { ...base.baseline, mode, closeout: 'commit-required' });
  const runId = dispatch.data.runId;
  expect((await startRun(root, runId, 'tester', { baselineValid: true, dependenciesReady: true, authorization: { by: 'tester' } })).ok).toBe(true);
  return { root, runId, token: (await readLease(root, runId))!.token, taskPath };
}

function ports(overrides: TaskVerificationPorts = {}): TaskVerificationPorts {
  return {
    command: async () => ({ ok: true, exitCode: 0, summary: 'passed' }),
    review: async (input) => ({ review: { kind: input.kind, verdict: 'approved', actor: input.actor, reviewedManifestHash: input.manifestHash },
      coverage: input.criteria.map((criterion) => ({ ...criterion, checkIds: ['check'] })) }),
    ...overrides,
  };
}

describe('task execution lifecycle', () => {
  it.each(['xdel', 'xflow'] as const)('executes %s with role-bound receipts and read-only review', async (mode) => {
    const f = await fixture(mode);
    const kinds: string[] = [];
    const conversations = new Set<string>();
    const review: NonNullable<TaskVerificationPorts['review']> = async (input, signal) => {
      kinds.push(input.kind);
      expect(conversations.has(input.turn.conversationId)).toBe(false);
      conversations.add(input.turn.conversationId);
      expect(await input.turn.toolGate!({ name: 'workspace_edit', arguments: { path: 'src/file.txt' } })).toMatchObject({ block: true });
      expect(await input.turn.toolGate!({ name: 'workspace_read', arguments: { path: 'src/file.txt' } })).toBeUndefined();
      if (input.kind === 'independent') {
        expect(input.turn.toolAllowlist).toEqual(['workspace.read']);
        expect(await input.turn.toolGate!({ name: 'workspace_read', arguments: { path: '.agents/.local/conversations/task.json' } })).toMatchObject({ block: true });
      }
      return ports().review!(input, signal);
    };
    const result = await executeTaskExecution(f.root, f.runId, f.token, { ...ports(), review, independentReview: review,
      implement: async (turn) => { conversations.add(turn.conversationId); await writeFile(join(f.root, 'src/file.txt'), 'implemented'); return { cancelled: false }; },
    });
    expect(result.errors).toEqual([]);
    expect(result.completed).toBe(true);
    expect(kinds).toEqual(mode === 'xflow' ? ['self', 'independent'] : ['self']);
    expect(result.receipt.actor).toContain(':implementor:');
    expect(result.receipt.review.actor === result.receipt.actor).toBe(mode === 'xdel');
  });

  it.each(['xdel', 'xflow'] as const)('applies %s repair policy and preserves concrete failure guidance', async (mode) => {
    const f = await fixture(mode);
    let implementations = 0;
    const review: NonNullable<TaskVerificationPorts['review']> = async (input, signal) => {
      const result = await ports().review!(input, signal);
      if (mode === 'xdel' || implementations === 1 && input.kind === 'independent') {
        result.review.verdict = 'needs-fix'; result.review.summary = 'src/file.txt must contain the repaired value';
      }
      return result;
    };
    const result = await executeTaskExecution(f.root, f.runId, f.token, { ...ports(), review, independentReview: review,
      implement: async (turn) => { if (++implementations === 2) expect(turn.systemPromptPrefix).toContain('must contain the repaired value'); return { cancelled: false }; },
    });
    expect(implementations).toBe(mode === 'xflow' ? 2 : 1);
    expect(result.completed).toBe(mode === 'xflow');
    expect((await loadRun(f.root, f.runId)).repairBudget.usedAuto).toBe(mode === 'xflow' ? 1 : 0);
  });

  it('exhausts xflow repair budget and rejects a forged evaluator identity', async () => {
    const f = await fixture('xflow');
    let implementations = 0;
    const independentReview: NonNullable<TaskVerificationPorts['review']> = async (input, signal) => {
      const result = await ports().review!(input, signal); result.review.verdict = 'needs-fix'; return result;
    };
    const result = await executeTaskExecution(f.root, f.runId, f.token, { ...ports(), independentReview, implement: async () => { implementations++; return { cancelled: false }; } });
    expect(result.completed).toBe(false);
    expect(implementations).toBe(2);
    expect((await loadRun(f.root, f.runId)).state).toBe('verifying');
    await expect(verifyTaskExecution(f.root, f.runId, f.token, { ...ports(), independentReview: async (input, signal) => {
      const result = await ports().review!(input, signal); result.review.actor = 'tester'; return result;
    } })).rejects.toThrow('assigned reviewer identity');
    expect((await loadRun(f.root, f.runId)).receipts).toHaveLength(2);
  });

  it('pauses cancelled delegated implementation before any verification', async () => {
    const f = await fixture('xflow');
    const abort = new AbortController();
    await expect(executeTaskExecution(f.root, f.runId, f.token, { ...ports(), independentReview: ports().review,
      implement: async () => { abort.abort(); return { cancelled: true }; },
    }, abort.signal)).rejects.toThrow();
    expect((await loadRun(f.root, f.runId)).state).toBe('paused');
    expect((await loadRun(f.root, f.runId)).receipts).toHaveLength(0);
  });
  it('pins a separate task context and blocks arbitrary commands and out-of-scope mutations', async () => {
    const f = await fixture();
    const turn = await prepareTaskTurn(f.root, f.runId, f.token);
    expect(turn.sourceTag).toBe('harness');
    expect(turn.systemPromptPrefix).toContain(URI);
    expect(turn.conversationId).toContain(f.runId);
    expect(await turn.toolGate!({ name: 'workspace_edit', arguments: { path: 'src/file.txt' } })).toBeUndefined();
    for (const path of ['src-other/file.txt', '../file.txt', '.agents/harness.json', 'C:/tmp/file.txt', 'src/file.txt:stream', 'src/file.txt.']) {
      expect(await turn.toolGate!({ name: 'workspace_edit', arguments: { path } })).toMatchObject({ block: true });
    }
    expect(await turn.toolGate!({ name: 'command_run', arguments: { program: 'node' } })).toMatchObject({ block: true, reason: expect.stringContaining('CAPABILITY_UNAVAILABLE') });
  });

  it('rejects linked mutation targets and ignored files', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'outside'));
    await symlink(join(f.root, 'outside'), join(f.root, 'src', 'alias'), 'junction');
    await link(join(f.root, 'src', 'file.txt'), join(f.root, 'outside', 'hard.txt'));
    await writeFile(join(f.root, '.gitignore'), 'src/ignored.txt\n');
    const turn = await prepareTaskTurn(f.root, f.runId, f.token);
    for (const path of ['src/alias/new.txt', 'src/file.txt', 'src/ignored.txt']) {
      expect(await turn.toolGate!({ name: 'workspace_create', arguments: { path } })).toMatchObject({ block: true });
    }
  });

  it('rechecks baseline, state and lease before a tool runs', async () => {
    const f = await fixture();
    const turn = await prepareTaskTurn(f.root, f.runId, f.token);
    const original = await readFile(f.taskPath, 'utf8');
    await writeFile(f.taskPath, original.replace('Change the source.', 'A different scope.'));
    expect(await turn.toolGate!({ name: 'workspace_edit', arguments: { path: 'src/file.txt' } })).toMatchObject({ block: true, reason: expect.stringContaining('STALE_BASELINE') });
    await writeFile(f.taskPath, original);
    await pauseRun(f.root, f.runId, f.token);
    await expect(prepareTaskTurn(f.root, f.runId, f.token)).rejects.toThrow('paused');
    await takeoverRun(f.root, f.runId, 'other', 'take ownership');
    expect(await turn.toolGate!({ name: 'workspace_read', arguments: { path: 'src/file.txt' } })).toMatchObject({ block: true, reason: expect.stringContaining('BUSY') });
  });

  it('requires delegated capability for xflow and explicit manual evidence', async () => {
    const delegated = await fixture('xflow');
    await expect(verifyTaskExecution(delegated.root, delegated.runId, delegated.token, ports())).rejects.toThrow('independent reviewer');
    const manual = await fixture('xdo', true);
    await expect(verifyTaskExecution(manual.root, manual.runId, manual.token, ports())).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    const f = await fixture();
    await expect(verifyTaskExecution(f.root, f.runId, f.token, {})).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    expect((await loadRun(f.root, f.runId)).state).toBe('running');
  });

  it('executes declared checks, records evidence, finishes and releases the lease', async () => {
    const f = await fixture();
    const result = await verifyTaskExecution(f.root, f.runId, f.token, ports({ command: async (step) => {
      expect(step).toMatchObject({ program: 'node', args: ['-e', 'process.exit(0)'], cwd: '.' });
      return { ok: true, exitCode: 0, summary: 'command passed' };
    } }));
    expect(result.errors).toEqual([]);
    expect(result.completed).toBe(true);
    expect(result.receipt.codeManifest).toEqual([{ repoId: REPO, path: 'src/file.txt', sha256: expect.any(String) }]);
    expect((await loadRun(f.root, f.runId)).completedReceiptId).toBe(result.receipt.id);
    expect(await readLease(f.root, f.runId)).toBeNull();
    await expect(prepareTaskTurn(f.root, f.runId, f.token)).rejects.toThrow();
  });

  it.each([{ ok: true, exitCode: 1 }, { ok: false, exitCode: 0 }, { ok: true, exitCode: 0, timedOut: true }])('never treats process status as evidence: %j', async (command) => {
    const f = await fixture();
    const result = await verifyTaskExecution(f.root, f.runId, f.token, ports({ command: async () => ({ ...command, summary: 'failed' }) }));
    expect(result.completed).toBe(false);
    expect(result.receipt.checks[0].status).toBe('failed');
    expect((await loadRun(f.root, f.runId)).state).toBe('verifying');
  });

  it('retains failed coverage evidence for an authorized repair', async () => {
    const f = await fixture();
    const failing = await verifyTaskExecution(f.root, f.runId, f.token, ports({ review: async (input) => ({ review: { kind: 'self', verdict: 'needs-fix', actor: 'tester', reviewedManifestHash: input.manifestHash }, coverage: [] }) }));
    expect(failing.completed).toBe(false);
    expect((await repairRun(f.root, f.runId, f.token, { failureReceiptId: failing.receipt.id, summary: 'fix coverage', auto: false, authorization: { by: 'tester' } })).ok).toBe(true);
    const repairTurn = await prepareTaskTurn(f.root, f.runId, f.token);
    expect(repairTurn.systemPromptPrefix).toContain('fix coverage');
    expect(repairTurn.systemPromptPrefix).toContain(failing.receipt.id);
    const fixed = await verifyTaskExecution(f.root, f.runId, f.token, ports());
    expect(fixed.completed).toBe(true);
    expect(fixed.receipt.attempt).toBe(2);
    expect(fixed.receipt.id).not.toBe(failing.receipt.id);
  });

  it.each(['edit', 'add', 'delete'])('refuses scoped code drift during review: %s', async (kind) => {
    const f = await fixture();
    const result = await verifyTaskExecution(f.root, f.runId, f.token, ports({ review: async (input, signal) => {
      if (kind === 'delete') await rm(join(f.root, 'src', 'file.txt'));
      else await writeFile(join(f.root, 'src', kind === 'add' ? 'added.txt' : 'file.txt'), 'changed');
      return ports().review!(input, signal);
    } }));
    expect(result.completed).toBe(false);
    expect(result.errors.join('')).toContain('STALE_BASELINE');
    expect(result.receipt.review.verdict).toBe('blocked');
  });

  it('refuses an unrelated review hash without storing evidence', async () => {
    const f = await fixture();
    await expect(verifyTaskExecution(f.root, f.runId, f.token, ports({ review: async (input, signal) => {
      const result = await ports().review!(input, signal);
      result.review.reviewedManifestHash = 'f'.repeat(64);
      return result;
    } }))).rejects.toThrow('tested manifest');
    expect((await loadRun(f.root, f.runId)).receipts).toEqual([]);
  });

  it('pauses verification on abort and never calls the reviewer', async () => {
    const f = await fixture();
    const abort = new AbortController();
    let reviewed = false;
    await expect(verifyTaskExecution(f.root, f.runId, f.token, ports({
      command: async () => { abort.abort(); return { ok: false, summary: 'cancelled' }; },
      review: async () => { reviewed = true; throw new Error('unreachable'); },
    }), abort.signal)).rejects.toThrow();
    expect(reviewed).toBe(false);
    expect((await loadRun(f.root, f.runId)).state).toBe('paused');
  });
});
