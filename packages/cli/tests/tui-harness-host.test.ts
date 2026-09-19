/**
 * Ink harness host: the task-bound controller behind the Ink loop.
 * Real CliSession over memory store; failing command plus stub review.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function openSession(workspace: string): Promise<CliSession> {
  const session = await CliSession.create({
    workspace,
    model: 'm',
    apiKey: 'k',
    store: memoryConversationStore(),
    catalog: parseCatalog({ providers: [{ id: 'a', models: ['m', 'm2'] }] }),
    streamTextFn: textStub(),
    env: {} as NodeJS.ProcessEnv,
  });
  if (isSessionValidationError(session)) throw new Error(session.message);
  return session;
}

function seed(root: string): void {
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.agents', 'harness.json'), JSON.stringify({ repoId: REPO }));
  writeFileSync(join(root, '.agents', 'notes', 'task.md'), TASK_TEXT);
  writeFileSync(join(root, 'src', 'file.txt'), 'initial');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
}

describe('ink harness host', () => {
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
