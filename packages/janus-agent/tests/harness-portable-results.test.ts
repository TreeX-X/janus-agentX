import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeManifestHash, parseNote, taskContractHash, type Receipt } from '@janus-agent/harness-core';
import { buildNoteIndex, collectTaskBaseline, proveRequirementCoverage, readTaskResult, runGit, sha256HexBytes } from '@janus-agent/harness-node';
import { dispatchRun, finishRun, recordReceipt, startRun, verifyRun, type LiveSnapshot } from '../src/harness/dispatcher.js';
import { loadRun, readLease, saveRun } from '../src/harness/run-store.js';
import { verifyTaskExecution } from '../src/harness/task-execution.js';
import { run as notesCli } from '../../notes-cli/src/cli.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const TASK = '55555555-5555-4333-8333-555555555555';
const REQ = '44444444-4444-4333-8333-444444444444';
const URI = `note://${REPO}/${TASK}`;
const TARGET = `note://${REPO}/${REQ}`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]) {
  const result = runGit(root, args);
  if (!result.ok) throw new Error(result.error);
  return result.stdout.trim();
}

async function fixture(closeout: 'commit-required' | 'working-tree-authorized' = 'commit-required') {
  const root = await mkdtemp(join(tmpdir(), 'portable-results-'));
  roots.push(root);
  await mkdir(join(root, '.agents', 'notes'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, '.agents', 'harness.json'), JSON.stringify({ name: 'Test', schemaVersion: 1, repoId: REPO, profile: SUPPORTED_HARNESS_PROFILE }));
  await writeFile(join(root, '.gitignore'), '.agents/.local/\n');
  await writeFile(join(root, 'src', 'file.txt'), 'tested bytes');
  await writeFile(join(root, 'src', 'binary.bin'), Buffer.from([0, 255, 13, 10, 128]));
  await writeFile(join(root, 'src', 'obsolete.txt'), 'remove this');
  await writeFile(join(root, '.agents', 'notes', 'requirement.md'), [
    '---', 'schema: harness-note/1', `id: ${REQ}`, 'kind: requirement', 'lifecycle: accepted', 'created: 2026-09-18', '---',
    '# Requirement', '', '## Problem', 'Need checked source.', '', '## Expected behavior', 'Source works.', '', '## Scope', 'Source.', '', '## Acceptance criteria', '- [ ] AC-1: source works', '',
  ].join('\n'));
  const taskPath = join(root, '.agents', 'notes', 'task.md');
  const text = ['---', 'schema: harness-note/1', `id: ${TASK} # identity stays byte-identical`, 'kind: task', 'lifecycle: accepted', 'created: 2026-09-18',
    `repositories: {primary: ${REPO}}`, `relations: [{type: implements, target: '${TARGET}', criteria: [AC-1]}]`,
    'work:', `  scope: [{repoId: ${REPO}, paths: [src/]}]`, `  acceptanceRefs: [{uri: '${TARGET}', criterionId: AC-1}]`,
    `  verification: [{id: check, kind: command, required: true, repoId: ${REPO}, cwd: '.', program: node, args: ['-e', 'process.exit(0)']}]`,
    '---', '', '# Task', '', '## Scope', 'Source.', '', '## Acceptance criteria', 'Inherited from the requirement.', '', '## Verification', 'Run check.', '',
  ].join('\n');
  await writeFile(taskPath, text);
  git(root, 'init');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '--no-gpg-sign', '-m', 'initial');
  await rm(join(root, 'src', 'obsolete.txt'));
  const base = await collectTaskBaseline(root, URI);
  if (!base.ok) throw new Error(JSON.stringify(base));
  const dispatched = await dispatchRun(root, { ...base.baseline, mode: 'xdo', closeout, ...(closeout === 'working-tree-authorized' ? { authorizationRef: 'user-task' } : {}) });
  expect(dispatched.errors).toEqual([]);
  const runId = dispatched.data.runId;
  expect((await startRun(root, runId, 'tester', { baselineValid: true, dependenciesReady: true, authorization: { by: 'tester' } })).ok).toBe(true);
  return { root, taskPath, original: text, runId, token: (await readLease(root, runId))!.token, baseline: base.baseline };
}

async function verify(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await verifyTaskExecution(f.root, f.runId, f.token, {
    command: async (step) => {
      execFileSync(step.program!, step.args!, { cwd: join(f.root, step.cwd), timeout: 5000 });
      return { ok: true, exitCode: 0, summary: 'real command passed' };
    },
    review: async (input) => ({ review: { kind: 'self', verdict: 'approved', reviewedManifestHash: input.manifestHash, actor: 'tester' },
      coverage: input.criteria.map((criterion) => ({ ...criterion, checkIds: ['check'] })) }),
  });
  expect(result.errors).toEqual([]);
  expect(result.completed).toBe(true);
  return result.receipt;
}

async function coverage(root: string) {
  const entry = (await buildNoteIndex(root)).byId.get(REQ)!;
  return proveRequirementCoverage(root, REPO, TARGET, entry.note!);
}

describe('portable task results', () => {
  it('executes checks, commits all assets, rebuilds without local state, and invalidates drift', async () => {
    const f = await fixture();
    const receipt = await verify(f);
    expect((await recordReceipt(f.root, f.runId, f.token, receipt)).ok).toBe(true);
    expect((await finishRun(f.root, f.runId, f.token, receipt.id, {} as LiveSnapshot)).ok).toBe(true);
    const text = await readFile(f.taskPath, 'utf8');
    expect(text).toContain(`${TASK} # identity stays byte-identical`);
    expect(text.slice(text.indexOf('# Task'))).toBe(f.original.slice(f.original.indexOf('# Task')));
    expect(taskContractHash(parseNote(text))).toBe(f.baseline.taskContractHash);
    expect(parseNote(text).meta.execution).toMatchObject({ state: 'done', attempt: 1, receipts: [receipt.id] });
    expect((await readTaskResult(f.root, URI, { closeout: true })).closeout?.satisfied).toBe(false);
    git(f.root, 'add', '.agents/notes', '.agents/evidence', 'src');
    git(f.root, 'commit', '--no-gpg-sign', '-m', 'land task and receipt');
    const landed = git(f.root, 'rev-parse', 'HEAD');
    const clone = await mkdtemp(join(tmpdir(), 'portable-clone-'));
    roots.push(clone);
    git(clone, 'clone', '--no-local', f.root, '.');
    const result = await readTaskResult(clone, URI, { closeout: true });
    expect(result).toMatchObject({ validity: 'valid', execution: { state: 'done' }, closeout: { satisfied: true, commit: landed } });
    expect((await coverage(clone)).covered).toBe(true);
    const cli = await notesCli(['--json', 'result', URI, '--closeout'], clone);
    expect(cli.exit).toBe(0);
    expect(JSON.parse(cli.stdout).data).toEqual(result);
    await rename(join(clone, '.agents', 'notes', 'task.md'), join(clone, '.agents', 'notes', 'renamed-task.md'));
    expect((await readTaskResult(clone, URI, { closeout: true })).closeout?.satisfied).toBe(true);
    await writeFile(join(clone, 'src', 'file.txt'), 'changed');
    expect((await readTaskResult(clone, URI, { closeout: true })).validity).toBe('stale');
    expect((await coverage(clone)).covered).toBe(false);
  }, 20000);

  it('requires HEAD reachability and rechecks rather than trusting a previous landing result', async () => {
    const f = await fixture();
    const base = git(f.root, 'rev-parse', 'HEAD');
    await verify(f);
    git(f.root, 'checkout', '-b', 'evidence');
    git(f.root, 'add', '.agents/notes', '.agents/evidence', 'src');
    git(f.root, 'commit', '--no-gpg-sign', '-m', 'evidence on other branch');
    const result = await readTaskResult(f.root, URI, { closeout: true });
    expect(result.closeout?.satisfied).toBe(true);
    git(f.root, 'checkout', '--detach', base);
    git(f.root, 'restore', '--source=evidence', '--worktree', '--', '.agents/notes', '.agents/evidence', 'src');
    expect((await readTaskResult(f.root, URI)).validity).toBe('valid');
    expect((await readTaskResult(f.root, URI, { closeout: true })).closeout?.satisfied).toBe(false);
    git(f.root, 'add', '.agents/notes');
    git(f.root, 'commit', '--no-gpg-sign', '-m', 'task without receipt');
    expect((await readTaskResult(f.root, URI, { closeout: true })).closeout?.satisfied).toBe(false);
  }, 15000);

  it.each(['source-addition', 'criterion', 'contract', 'receipt'])('rejects changed %s after verification', async (kind) => {
    const f = await fixture();
    const receipt = await verify(f);
    if (kind === 'source-addition') await writeFile(join(f.root, 'src', 'new.txt'), 'new source');
    if (kind === 'criterion') {
      const path = join(f.root, '.agents', 'notes', 'requirement.md');
      await writeFile(path, (await readFile(path, 'utf8')).replace('AC-1: source works', 'AC-1: different requirement'));
    }
    if (kind === 'contract') await writeFile(f.taskPath, (await readFile(f.taskPath, 'utf8')).replace('## Scope\nSource.', '## Scope\nDifferent scope.'));
    if (kind === 'receipt') await writeFile(join(f.root, '.agents', 'evidence', `${receipt.id}.json`), JSON.stringify({ ...receipt, coverage: [] }));
    expect((await readTaskResult(f.root, URI, { closeout: true })).validity).toBe('stale');
    expect((await coverage(f.root)).covered).toBe(false);
  });

  it('retains explicit working-tree authorization without claiming a commit or requiring Git', async () => {
    const f = await fixture('working-tree-authorized');
    await verify(f);
    await rm(join(f.root, '.git'), { recursive: true });
    expect((await readTaskResult(f.root, URI, { closeout: true })).closeout).toMatchObject({ satisfied: true, strategy: 'working-tree-authorized' });
    expect((await readTaskResult(f.root, URI, { closeout: true })).closeout?.commit).toBeUndefined();
  });

  it('does not claim a foreign running task or allow another prepare', async () => {
    const f = await fixture();
    const foreign = await mkdtemp(join(tmpdir(), 'foreign-run-'));
    roots.push(foreign);
    await cp(join(f.root, '.agents', 'notes'), join(foreign, '.agents', 'notes'), { recursive: true });
    await cp(join(f.root, '.agents', 'harness.json'), join(foreign, '.agents', 'harness.json'));
    const before = await readFile(join(foreign, '.agents', 'notes', 'task.md'), 'utf8');
    expect((await readTaskResult(foreign, URI)).execution?.state).toBe('running');
    const other = await dispatchRun(foreign, { ...f.baseline, mode: 'xdo', closeout: 'commit-required' });
    expect(other.errors.some((error) => error.code === 'NOT_READY')).toBe(true);
    expect(await readFile(join(foreign, '.agents', 'notes', 'task.md'), 'utf8')).toBe(before);
  });

  it.each(['journal', 0, 1, 2] as const)('recovers interrupted evidence/state/cache writes at %s', async (stage) => {
    const f = await fixture();
    const manifest = [{ repoId: REPO, path: 'src/file.txt', sha256: sha256HexBytes(Buffer.from('tested bytes')) }];
    await verifyRun(f.root, f.runId, f.token, manifest);
    const run = await loadRun(f.root, f.runId);
    const receipt: Receipt = { schema: 'harness-receipt/1', id: 'failure', taskUri: URI, mode: 'xdo', attempt: 1,
      taskContractHash: f.baseline.taskContractHash, inputs: f.baseline.inputs, codeManifest: manifest,
      checks: [{ id: 'check', kind: 'command', required: true, repoId: REPO, status: 'failed', exitCode: 1, summary: 'failed check', performedBy: 'tester' }], coverage: [],
      review: { kind: 'self', verdict: 'needs-fix', actor: 'tester', reviewedManifestHash: codeManifestHash(manifest) }, createdAt: new Date().toISOString(), actor: 'tester' };
    run.receipts.push(receipt.id);
    await expect(saveRun(f.root, run, receipt, { failAfter: stage })).rejects.toThrow('injected');
    expect((await loadRun(f.root, f.runId)).receipts).toEqual(['failure']);
    expect(parseNote(await readFile(f.taskPath, 'utf8')).meta.execution?.receipts).toEqual(['failure']);
    expect((await readTaskResult(f.root, URI)).validity).toBe('unverified');
    expect((await recordReceipt(f.root, f.runId, f.token, receipt)).ok).toBe(true);
    expect((await recordReceipt(f.root, f.runId, f.token, { ...receipt, createdAt: '2020-01-01T00:00:00Z' })).errors.some((error) => error.code === 'CONFLICT')).toBe(true);
  });

  it('preserves user edits and refuses stale concurrent state writes', async () => {
    const f = await fixture();
    const first = await loadRun(f.root, f.runId);
    const second = await loadRun(f.root, f.runId);
    first.state = 'paused';
    first.pausedFrom = 'running';
    await saveRun(f.root, first);
    second.state = 'cancelled';
    await expect(saveRun(f.root, second)).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = await loadRun(f.root, f.runId);
    const edited = (await readFile(f.taskPath, 'utf8')) + '\n## Results\nUser observation.\n';
    await writeFile(f.taskPath, edited);
    current.state = 'cancelled';
    await expect(saveRun(f.root, current)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(f.taskPath, 'utf8')).toBe(edited);
  });

  it('blocks journal recovery when a user edits an unfinished target', async () => {
    const f = await fixture();
    const run = await loadRun(f.root, f.runId);
    run.state = 'paused';
    await expect(saveRun(f.root, run, undefined, { failAfter: 'journal' })).rejects.toThrow('injected');
    const edited = (await readFile(f.taskPath, 'utf8')) + '\n## Results\nForeign edit.\n';
    await writeFile(f.taskPath, edited);
    await expect(loadRun(f.root, f.runId)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(f.taskPath, 'utf8')).toBe(edited);
    expect((await readTaskResult(f.root, URI)).errors[0].code).toBe('RECOVERY_REQUIRED');
  });
});
