import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/**
 * Ink harness host: the task-bound controller behind the Ink loop.
 * Real CliSession over memory store; failing command plus stub review.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/tui/exec.js';
import { createInkHarnessHost, type InkHarnessSession } from '../src/tui/harness-host.js';
import type { TaskVerificationPorts } from '@janus-agent/janus-agent';
import { CliSession, isSessionValidationError } from '../src/session.js';
import { memoryConversationStore } from '../src/conversations.js';
import { parseCatalog } from '../src/providers.js';
import type { ChatTurnPorts } from '@janus-agent/janus-agent';

type StreamFn = ChatTurnPorts['streamTextFn'];

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const NOTE = '33333333-3333-4333-8333-333333333333';
const TASK = `note://${REPO}/${NOTE}`;
const TASK_TEXT = ['---', 'schema: harness-note/1', `id: ${NOTE}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-09-19',
  'work:', `  scope: [{repoId: ${REPO}, paths: [src/]}]`, `  acceptanceRefs: [{uri: '${TASK}', criterionId: AC-1}]`,
  `  verification: [{id: v1, kind: command, required: true, repoId: ${REPO}, cwd: ., program: node, args: ['--test']}]`,
  '---', '', '# Ink task', '', '## Scope', '', 'Ink.', '', '## Acceptance criteria', '', '- [ ] AC-1: ink works', '', '## Verification', '', 'Run it.', '',
].join('\n');

function textStub(): StreamFn {
  return (async () => ({
    textStream: (async function* () { yield 'ok' })(),
  })) as StreamFn;
}

async function openSession(workspace: string, streamTextFn = textStub()): Promise<CliSession> {
  const session = await CliSession.create({
    workspace,
    model: 'm',
    apiKey: 'k',
    store: memoryConversationStore(),
    catalog: parseCatalog({ providers: [{ id: 'a', models: ['m', 'm2'] }] }),
    streamTextFn,
    env: {} as NodeJS.ProcessEnv,
  });
  if (isSessionValidationError(session)) throw new Error(session.message);
  return session;
}

function seed(root: string): void {
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.agents', 'harness.json'), JSON.stringify({ name: 'Test', schemaVersion: 1, repoId: REPO, profile: SUPPORTED_HARNESS_PROFILE }));
  writeFileSync(join(root, '.agents', 'notes', 'task.md'), TASK_TEXT);
  writeFileSync(join(root, 'src', 'file.txt'), 'initial');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
}

describe('ink harness host', () => {
  it('routes chat into task history and refuses paused turns before calling the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-harness-turn-'));
    let session: CliSession | undefined;
    const prompts: string[] = [];
    try {
      seed(root);
      session = await openSession(root, async (options) => {
        prompts.push(JSON.stringify(options.messages));
        return { textStream: (async function* () { yield 'report only' })() };
      });
      const live = session;
      const host = createInkHarnessHost({ session: () => live, signal: () => undefined, owner: 'tester' });
      const send = (prompt: string) => host.executeTurn((task) => live.sendTurn(prompt, {}, undefined, task));
      await send('ordinary secret');
      expect((await host.run([TASK])).stderr).toEqual([]);
      await send('task request');
      expect(prompts[1]).toContain('Task-bound execution');
      expect(prompts[1]).not.toContain('ordinary secret');
      await host.run(['pause']);
      await expect(send('must not run')).rejects.toThrow('task is paused');
      expect(prompts).toHaveLength(2);
      await host.run(['resume']);
      await host.executeTurn(async () => ({ cancelled: true }));
      expect((await host.run(['status'])).stdout.join('')).toContain('paused');
      host.exitMode();
      await send('ordinary again');
      expect(prompts[2]).toContain('ordinary secret');
      expect(JSON.parse(prompts[2]).filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content)).not.toContain('task request');
    } finally { await session?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['src/output.txt', 'outside.txt', '.agents/notes/task.md'])('constrains Ink model writes: %s', async (path) => {
    const root = mkdtempSync(join(tmpdir(), 'ink-harness-write-'));
    let session: CliSession | undefined;
    let rounds = 0;
    try {
      seed(root);
      session = await openSession(root, async () => {
        if (rounds++ === 0) return {
          textStream: (async function* () {})(),
          fullStream: (async function* () {
            yield { type: 'tool-call', toolCallId: 'create', toolName: 'workspace_create', args: { path, content: 'task output' } };
            yield { type: 'finish', finishReason: 'tool-calls' };
          })(),
        };
        return { textStream: (async function* () { yield 'report only' })() };
      });
      const live = session;
      const host = createInkHarnessHost({ session: () => live, signal: () => undefined, owner: 'tester' });
      expect((await host.run([TASK])).stderr).toEqual([]);
      await host.executeTurn((task) => live.sendTurn('Create the task output file.', {}, undefined, task));
      if (path.startsWith('.agents/')) {
        expect(readFileSync(join(root, path), 'utf8')).not.toBe('task output');
        expect((await host.run(['status'])).stdout.join('')).toContain('running');
      } else expect(existsSync(join(root, path))).toBe(path.startsWith('src/'));
    } finally { await session?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('reports the mode off without a binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-harness-'));
    try {
      seed(root);
      const session = await openSession(root);
      const host = createInkHarnessHost({
        session: () => session,
        ports: (actor) => session.taskVerificationPorts(actor),
        signal: () => undefined,
        owner: 'tester',
      });
      expect((await executeCommand(session, 'harness', [], { harness: host })).stdout.join('')).toContain('harness mode is off');
      expect((await executeCommand(session, 'harness', [], {})).stderr).toEqual(['janus: harness mode is unavailable here.']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enters, verifies with failure, auto-repairs, and exits through Ink routing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-harness-'));
    try {
      seed(root);
      const session = await openSession(root);
      const failingPorts = (actor: string, live: InkHarnessSession): TaskVerificationPorts => ({
        ...(live.taskVerificationPorts(actor) as object),
        command: async () => ({ ok: false, exitCode: 1, summary: 'boom' }),
        review: async (input) => ({
          review: { kind: 'self', verdict: 'needs-fix', reviewedManifestHash: input.manifestHash, actor: 'tester' },
          coverage: [],
        }),
      });
      const host = createInkHarnessHost({
        session: () => session,
        ports: failingPorts,
        signal: () => undefined,
        owner: 'tester',
      });
      const entered = await executeCommand(session, 'harness', [TASK], { harness: host });
      expect(entered.stderr).toEqual([]);
      expect(entered.stdout.join('')).toContain('harness mode: xdo');
      const verified = await executeCommand(session, 'harness', ['verify'], { harness: host });
      expect(verified.stdout.join('')).toContain('not complete');
      expect(verified.stdout.join('')).toContain('auto repair started (attempt 2)');
      const status = await executeCommand(session, 'harness', ['status'], { harness: host });
      expect(status.stdout.join('')).toMatch(/running.*attempt 2/);
      const exited = await executeCommand(session, 'exit', [], { harness: host });
      expect(exited.exit).toBeUndefined();
      expect((await executeCommand(session, 'harness', [], { harness: host })).stdout.join('')).toContain('harness mode is off');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
