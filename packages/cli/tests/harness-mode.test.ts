import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/**
 * TUI harness mode shell: enter/status/reattach/pause/cancel/takeover/exit
 * against the real dispatch kernel. Temp checkouts only, no model.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeManifestHash, criterionHash, parseNote, taskContractHash } from '@janus-agent/harness-core';
import { HarnessController, cliOwner, createHarnessHost } from '../src/harness-mode.js';
import { CliSession, isSessionValidationError } from '../src/session.js';
import { runGit } from '@janus-agent/harness-node';
import { listRuns } from '@janus-agent/janus-agent';
import { arrayLineSource, runRepl } from '../src/repl.js';
import { memoryConversationStore } from '../src/conversations.js';

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
  writeFileSync(join(root, '.agents', 'harness.json'), JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'T', profile: SUPPORTED_HARNESS_PROFILE }));
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), requirement());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dec--33333333.md'), decision());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), taskNote(DEP, 'Dep task', '', [
    'execution:', '  mode: xdo', '  state: done', '  baseline:',
    `    taskContractHash: ${'a'.repeat(64)}`, '    inputs: []', '  attempt: 1',
    '  receipts: [rc-dep]', '  closeout: commit-required',
  ].join('\n')));
  const depPath = join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md');
  const depText = readFileSync(depPath, 'utf8').replace(`uri: ${REQ_URI}`, `uri: note://${REPO}/${DEP}`).replace("paths: ['./']", "paths: ['dependency/']");
  const depHash = taskContractHash(parseNote(depText));
  writeFileSync(depPath, depText.replace('a'.repeat(64), depHash));
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
      review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: codeManifestHash([]), actor: 's' },
      createdAt: '2026-09-17T00:00:00.000Z', actor: 's',
    }));
    writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify({
      schema: 'harness-receipt/1', id: 'rc-dep', taskUri: `note://${REPO}/${DEP}`, mode: 'xdo', attempt: 1,
      taskContractHash: depHash, inputs: [], codeManifest: [],
      checks: [{ id: 'v1', kind: 'manual', required: true, status: 'passed', repoId: REPO, summary: 'observed', performedBy: 's' }],
      coverage: [{ uri: `note://${REPO}/${DEP}`, criterionId: 'AC-1', criterionHash: criterionHash('- [ ] AC-1: thing done'), checkIds: ['v1'] }],
      review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: codeManifestHash([]), actor: 's' },
      createdAt: '2026-09-17T00:00:00.000Z', actor: 's',
    }));
  }
}

function controller(root: string, owner = 'tester'): HarnessController {
  return new HarnessController(() => root, owner);
}

function executionSeed(root: string): void {
  seed(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'file.txt'), 'initial');
  const path = join(root, '.agents', 'notes', '2026-09-17-main--55555555.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace("paths: ['./']", "paths: ['src/']").replace('kind: manual', 'kind: command').replace('description: Eyeball it.', "program: node\n      args: ['-e', 'process.exit(0)']"));
  expect(runGit(root, ['init']).ok).toBe(true);
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
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), taskNote(MAIN, 'Blocked task', `relations:\n  - type: implements\n    target: ${REQ_URI}\n    criteria: [AC-1]\n  - type: depends-on\n    target: ${REQ_URI}`));
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

  it('runs a task through the plain REPL without mixing build history or claiming done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-turn-'));
    const prompts: string[] = [];
    const offered: string[][] = [];
    const errors: string[] = [];
    try {
      executionSeed(root);
      const code = await runRepl({ workspace: root, model: 'm', plain: true }, {
        env: {}, store: memoryConversationStore(), configPath: null, authPath: null,
        lines: arrayLineSource(['ordinary secret', `/harness ${MAIN}`, 'task request', '/harness pause', 'must not execute', '/harness resume', '/exit', 'ordinary again', '/exit']),
        stdout: () => undefined, stderr: (text) => errors.push(text),
        streamTextFn: async (options) => {
          prompts.push(JSON.stringify(options.messages));
          offered.push(Object.keys(options.tools as object));
          return { textStream: (async function* () { yield 'report only' })() };
        },
      });
      expect(code).toBe(0);
      expect(prompts).toHaveLength(3);
      expect(prompts[1]).toContain('task request');
      expect(prompts[1]).toContain('Task-bound execution');
      expect(prompts[1]).not.toContain('ordinary secret');
      expect(offered[1]).not.toContain('command_run');
      expect(prompts[2]).toContain('ordinary secret');
      expect(JSON.parse(prompts[2]).filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content)).not.toContain('task request');
      expect(errors.join('')).toContain('task is paused');
      expect((await listRuns(root))[0].state).toBe('running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('executes real verification commands and parses a read-only self-review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-verify-'));
    let session: CliSession | undefined;
    try {
      executionSeed(root);
      const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async (options) => {
        const messages = options.messages as Array<{ role: string; content: string }>;
        const prompt = messages.filter((message) => message.role === 'user').at(-1)!.content;
        const lines = prompt.split('\n');
        const shape = JSON.parse(lines.at(-1)!);
        shape.review.verdict = 'approved';
        shape.coverage = shape.coverage.map((row: object) => ({ ...row, checkIds: ['v1'] }));
        expect(Object.keys(options.tools as object)).not.toContain('workspace_edit');
        expect(Object.keys(options.tools as object)).not.toContain('command_run');
        return { textStream: (async function* () { yield JSON.stringify(shape) })() };
      } });
      if (isSessionValidationError(created)) throw new Error(created.message);
      session = created;
      const c = controller(root);
      expect((await c.enter(MAIN)).stderr).toEqual([]);
      const result = await c.verify((actor) => created.taskVerificationPorts(actor));
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join('')).toContain('done; closeout remains separate');
      expect((await listRuns(root))[0].state).toBe('done');
      expect((await c.control('closeout')).stdout.join('')).toContain('no current-branch commit');
    } finally {
      await session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto repairs once after failed verification, then stops at spent budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-autorepair-'));
    let session: CliSession | undefined;
    try {
      executionSeed(root);
      const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async (options) => {
        const messages = options.messages as Array<{ role: string; content: string }>;
        const prompt = messages.filter((message) => message.role === 'user').at(-1)!.content;
        const lines = prompt.split('\n');
        const shape = JSON.parse(lines.at(-1)!);
        shape.review.verdict = 'approved';
        shape.coverage = shape.coverage.map((row: object) => ({ ...row, checkIds: ['v1'] }));
        return { textStream: (async function* () { yield JSON.stringify(shape) })() };
      } });
      if (isSessionValidationError(created)) throw new Error(created.message);
      session = created;
      const c = controller(root);
      expect((await c.enter(MAIN)).stderr).toEqual([]);
      const failing = (actor: string) => ({
        ...created.taskVerificationPorts(actor),
        command: async () => ({ ok: false, exitCode: 1, summary: 'boom' }),
      });
      const first = await c.verify(failing);
      expect(first.stdout.join('')).toContain('auto repair started (attempt 2)');
      const second = await c.verify(failing);
      expect(second.stdout.join('')).toContain('not complete');
      expect(second.stdout.join('')).not.toContain('auto repair started');
    } finally {
      await session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['src/new.txt', 'outside.txt'])('enforces the task scope on an actual model tool call: %s', async (path) => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-write-'));
    let session: CliSession | undefined;
    let rounds = 0;
    try {
      executionSeed(root);
      const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async () => {
        if (rounds++ === 0) return {
          textStream: (async function* () {})(),
          fullStream: (async function* () {
            yield { type: 'tool-call', toolCallId: 'create', toolName: 'workspace_create', args: { path, content: 'task output' } };
            yield { type: 'finish', finishReason: 'tool-calls' };
          })(),
        };
        return { textStream: (async function* () { yield 'report only' })() };
      } });
      if (isSessionValidationError(created)) throw new Error(created.message);
      session = created;
      const c = controller(root);
      await c.enter(MAIN);
      await c.executeTurn((task) => created.sendTurn('Create the task output file.', {}, undefined, task));
      expect(existsSync(join(root, path))).toBe(path.startsWith('src/'));
      expect((await listRuns(root))[0].state).toBe('running');
    } finally { await session?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects prose-only review after successful verification commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-review-'));
    let session: CliSession | undefined;
    try {
      executionSeed(root);
      const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async () => ({ textStream: (async function* () { yield 'Everything passed.' })() }) });
      if (isSessionValidationError(created)) throw new Error(created.message);
      session = created;
      const c = controller(root);
      await c.enter(MAIN);
      expect((await c.verify((actor) => created.taskVerificationPorts(actor))).stderr.join('')).toContain('structured JSON evidence');
      expect((await listRuns(root))[0]).toMatchObject({ state: 'verifying', receipts: [] });
    } finally { await session?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels a real verification process while keeping the chat session usable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-abort-'));
    let session: CliSession | undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      executionSeed(root);
      const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async () => ({ textStream: (async function* () { yield 'still available' })() }) });
      if (isSessionValidationError(created)) throw new Error(created.message);
      session = created;
      timer = setTimeout(() => abort.abort(), 200);
      const result = await created.taskVerificationPorts('tester').command!({ id: 'slow', kind: 'command', required: true, repoId: REPO, cwd: '.', program: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] }, abort.signal);
      expect(result.ok).toBe(false);
      expect((await created.sendTurn('continue ordinary chat')).text).toBe('still available');
    } finally {
      if (timer) clearTimeout(timer);
      await session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores task history after reattachment and pauses a cancelled turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-resume-'));
    let session: CliSession | undefined;
    try {
      executionSeed(root);
      const c = controller(root);
      await c.enter(MAIN);
      let prompt = '';
      const create = async () => {
        const created = await CliSession.create({ workspace: root, model: 'm', env: {}, streamTextFn: async (options) => {
          prompt = JSON.stringify(options.messages);
          return { textStream: (async function* () { yield 'saved' })() };
        } });
        if (isSessionValidationError(created)) throw new Error(created.message);
        return created;
      };
      session = await create();
      await c.executeTurn((task) => session!.sendTurn('task history', {}, undefined, task));
      await session.close();
      session = await create();
      const attached = controller(root);
      await attached.enter(MAIN);
      await attached.executeTurn((task) => session!.sendTurn('continue task', {}, undefined, task));
      expect(prompt).toContain('task history');
      await attached.executeTurn(async () => ({ cancelled: true }));
      expect((await listRuns(root))[0].state).toBe('paused');
    } finally { await session?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers a moved baseline through explicit pause, rebaseline and start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-harness-baseline-'));
    try {
      executionSeed(root);
      const c = controller(root);
      await c.enter(MAIN);
      const path = join(root, '.agents', 'notes', '2026-09-17-main--55555555.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace('Do the thing.', 'New task scope.'));
      expect((await c.enter(MAIN)).stderr.join('')).toContain('STALE_BASELINE');
      expect((await c.pause()).stderr).toEqual([]);
      expect((await c.control('rebaseline')).stderr).toEqual([]);
      expect((await c.control('start')).stderr).toEqual([]);
      expect((await listRuns(root))[0]).toMatchObject({ state: 'running', attempt: 2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
