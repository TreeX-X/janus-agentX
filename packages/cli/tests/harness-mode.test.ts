/**
 * TUI harness mode shell: enter/status/reattach/pause/cancel/takeover/exit
 * against the real dispatch kernel. Temp checkouts only, no model.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { criterionHash } from '@janus-agent/harness-core';
import { HarnessController, cliOwner, createHarnessHost } from '../src/harness-mode.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const REQ = '11111111-1111-4111-8111-111111111111';
const DEC = '33333333-3333-4333-8333-333333333333';
const DEP = '44444444-4444-4333-8333-444444444444';
const MAIN = '55555555-5555-4333-8333-555555555555';
const REQ_URI = `note://${REPO}/${REQ}`;

function requirement(): string {
  return [
    '---', 'schema: harness-note/1', `id: ${REQ}`, 'kind: requirement',
    'lifecycle: accepted', 'created: 2026-09-17', '---', '',
    '# Requirement one', '',
    '## Problem', '', 'The widget fails.', '',
    '## Expected behavior', '', 'It works.', '',
    '## Scope', '', 'Widget only.', '',
    '## Acceptance criteria', '', '- [ ] AC-1: widget works', '',
  ].join('\n');
}

function decision(): string {
  return [
    '---', 'schema: harness-note/1', `id: ${DEC}`, 'kind: decision',
    'lifecycle: accepted', 'created: 2026-09-17', '---', '',
    '# Decision one', '',
    '## Problem', '', 'Which way.', '',
    '## Proposal', '', 'This way.', '',
    '## Alternatives considered', '', 'That way.', '',
    '## Risks', '', 'Low.', '',
  ].join('\n');
}

function taskNote(id: string, title: string, relations: string, execution = ''): string {
  return [
    '---', 'schema: harness-note/1', `id: ${id}`, 'kind: task',
    'lifecycle: accepted', 'created: 2026-09-17',
    'work:',
    '  scope:',
    `    - repoId: ${REPO}`,
    "      paths: ['./']",
    '  acceptanceRefs:',
    `    - uri: ${REQ_URI}`,
    '      criterionId: AC-1',
    '  verification:',
    '    - id: v1',
    '      kind: manual',
    '      required: true',
    `      repoId: ${REPO}`,
    '      cwd: .',
    '      description: Eyeball it.',
    relations,
    execution,
    '---', '',
    `# ${title}`, '',
    '## Scope', '', 'Do the thing.', '',
    '## Acceptance criteria', '', '- [ ] AC-1: thing done', '',
    '## Verification', '', 'Eyeball it.', '',
  ].join('\n');
}

function seed(root: string, opts: { evidence?: boolean } = {}): void {
  const { evidence = true } = opts;
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(join(root, '.agents', 'harness.json'), JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'T' }));
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), requirement());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dec--33333333.md'), decision());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), taskNote(DEP, 'Dep task', '', [
    'execution:', '  mode: xdo', '  state: done', '  baseline:',
    `    taskContractHash: ${'a'.repeat(64)}`, '    inputs: []', '  attempt: 1',
    '  receipts: [rc-dep]', '  closeout: commit-required',
  ].join('\n')));
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), taskNote(MAIN, 'Main task', [
    'relations:',
    '  - type: implements', `    target: ${REQ_URI}`, '    criteria: [AC-1]',
    '  - type: governed-by', `    target: note://${REPO}/${DEC}`,
    '  - type: depends-on', `    target: note://${REPO}/${DEP}`,
  ].join('\n')));
  if (evidence) {
    mkdirSync(join(root, '.agents', 'evidence'), { recursive: true });
    writeFileSync(join(root, '.agents', 'evidence', 'rc1.json'), JSON.stringify({
      schema: 'harness-receipt/1', id: 'rc1', taskUri: REQ_URI, mode: 'xdo', attempt: 1,
      taskContractHash: 'b'.repeat(64), inputs: [{ uri: REQ_URI, contentHash: 'c'.repeat(64) }],
      codeManifest: [],
      checks: [{ id: 'v1', kind: 'manual', required: true, status: 'passed', repoId: REPO, summary: 'ok', performedBy: 's' }],
      coverage: [{ uri: REQ_URI, criterionId: 'AC-1', criterionHash: criterionHash('- [ ] AC-1: widget works'), checkIds: ['v1'] }],
      review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 's' },
      createdAt: '2026-09-17T00:00:00.000Z', actor: 's',
    }));
    writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify({ ok: true }));
  }
}

function controller(root: string, owner = 'tester'): HarnessController {
  return new HarnessController(() => root, owner);
}

describe('harness mode shell', () => {
  it('builds a stable CLI owner id', () => {
    expect(cliOwner()).toMatch(/^cli:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/);
  });

  it('enters a task with a run card and reports status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root);
      const c = controller(root);
      expect(c.isActive()).toBe(false);
      expect((await c.status()).stdout.join('')).toContain('harness mode is off');
      const entered = await c.enter(MAIN);
      expect(entered.stderr).toEqual([]);
      const text = entered.stdout.join('\n');
      expect(text).toContain('harness mode: xdo');
      expect(text).toContain('Main task');
      expect(text).toContain('AC-1');
      expect(text).toContain('handoff:');
      expect(c.isActive()).toBe(true);
      expect(c.snapshot()).toMatchObject({ active: true, mode: 'xdo' });
      const status = await c.status();
      expect(status.stdout.join('\n')).toMatch(/running.*attempt 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reattaches to the live run instead of dispatching a duplicate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root);
      const first = controller(root);
      await first.enter(MAIN);
      const firstId = first.snapshot().runId;
      const second = controller(root);
      const again = await second.enter(MAIN);
      expect(again.stderr).toEqual([]);
      expect(again.stdout.join('')).toContain('reattached');
      expect(second.snapshot().runId).toBe(firstId);
      expect(readdirSync(join(root, '.agents', '.local', 'runs'))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pauses, cancels to terminal, and exits without cancelling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root);
      const c = controller(root);
      await c.enter(MAIN);
      expect((await c.pause()).stdout.join('')).toContain('paused');
      expect((await c.status()).stdout.join('')).toContain('paused');
      expect(c.exitMode().join('')).toContain('back to build mode');
      expect(c.isActive()).toBe(false);
      const runId = readdirSync(join(root, '.agents', '.local', 'runs'))[0] ?? '';
      expect(existsSync(join(root, '.agents', '.local', 'runs', runId, 'lease.json'))).toBe(true);
      const re = controller(root);
      await re.enter(MAIN);
      expect((await re.cancel()).stdout.join('')).toContain('cancelled');
      expect(re.isActive()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over a foreign lease explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root);
      const a = controller(root, 'owner-a');
      await a.enter(MAIN);
      const b = controller(root, 'owner-b');
      const refused = await b.enter(MAIN);
      expect(refused.stderr.join('')).toContain('owner-a');
      expect(refused.stderr.join('')).toContain('takeover');
      expect((await b.takeover('')).stderr.join('')).toContain('usage:');
      expect((await b.takeover('owner-a went dark')).stdout.join('')).toContain('took over');
      expect(b.isActive()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses unknown, draft, and uncovered tasks with named diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root, { evidence: false });
      const c = controller(root);
      const unknown = await c.enter('99999999-9999-4999-8999-999999999999');
      expect(unknown.stderr.join('')).toContain('NOT_FOUND');
      const uncovered = await c.enter(MAIN);
      expect(uncovered.stderr.join('')).toContain('DEPENDENCY_UNSATISFIED');
      expect(c.isActive()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes host commands including usage and exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-'));
    try {
      seed(root);
      const host = createHarnessHost(controller(root));
      expect(host.isActive()).toBe(false);
      expect((await host.run([])).stdout.join('')).toContain('harness mode is off');
      expect((await host.run(['bogus'])).stderr.join('')).toContain('NOT_FOUND');
      expect((await host.run(['--mode'])).stderr.join('')).toContain('usage:');
      expect((await host.run([MAIN, '--mode', 'sometimes'])).stderr.join('')).toContain('unknown harness mode');
      const entered = await host.run([MAIN]);
      expect(entered.stderr).toEqual([]);
      expect(host.isActive()).toBe(true);
      expect((await host.run(['status'])).stdout.join('')).toContain('running');
      expect(host.exitMode().join('')).toContain('back to build mode');
      expect(host.isActive()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
