import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/**
 * External runner launch: capability-free entry display plus spawned
 * launches with history, all refusing cleanly outside the external lane.
 * Temp dirs only; spawned processes are faked.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cancelRun,
  dispatchRun,
  loadRun,
  readLaunches,
  readLease,
  startRun,
  takeoverRun,
  verifyRun,
} from '@janus-agent/janus-agent';
import { parseNote, taskContractHash } from '@janus-agent/harness-core';
import { HarnessController } from '../src/harness-mode.js';
import { buildExternalEntryCommand, launchExternalRun } from '../src/external-runner.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const NOTE = '22222222-2222-4222-8222-222222222222';
const TASK = `note://${REPO}/${NOTE}`;
const TASK_TEXT = ['---', 'schema: harness-note/1', `id: ${NOTE}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-09-19',
  'work:', `  scope: [{repoId: ${REPO}, paths: [./]}]`, `  acceptanceRefs: [{uri: '${TASK}', criterionId: AC-1}]`,
  `  verification: [{id: v1, kind: command, required: true, repoId: ${REPO}, cwd: ., program: node, args: ['--test']}]`,
  '---', '', '# External task', '', '## Scope', '', 'Outside.', '', '## Acceptance criteria', '', '- [ ] AC-1: outside works', '', '## Verification', '', 'Run it outside.', '',
].join('\n');
const CONTRACT = taskContractHash(parseNote(TASK_TEXT));

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'external-runner-'));
  mkdirSync(join(dir, '.agents', 'notes'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'harness.json'), JSON.stringify({ name: 'Test', schemaVersion: 1, repoId: REPO, profile: SUPPORTED_HARNESS_PROFILE }));
  writeFileSync(join(dir, '.agents', 'notes', 'task.md'), TASK_TEXT);
  return dir;
}

async function externalRun(dir: string, started = false): Promise<string> {
  const d = await dispatchRun(dir, {
    taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT,
    inputs: [], closeout: 'commit-required', executor: 'external',
  });
  expect(d.ok).toBe(true);
  if (started) {
    const s = await startRun(dir, d.data.runId, 'owner-1', {
      baselineValid: true, dependenciesReady: true, authorization: { by: 'owner-1' },
    });
    expect(s.ok).toBe(true);
  }
  return d.data.runId;
}

interface SpawnCall { program: string; args: string[]; opts: { cwd: string; detached: boolean } }

function fakeSpawn(calls: SpawnCall[], pid = 4242) {
  return (program: string, args: string[], opts: { cwd: string; detached: boolean }) => {
    calls.push({ program, args, opts });
    return { pid };
  };
}

describe('external runner launch', () => {
  it('spawns with the caller array and records the launch', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir);
      const calls: SpawnCall[] = [];
      const out = await launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'codex', program: 'codex', args: ['--task', 'x'],
      }, { spawn: fakeSpawn(calls) });
      expect(out.launched).toBe(true);
      expect(out.pid).toBe(4242);
      expect(out.command).toEqual(['codex', '--task', 'x']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ program: 'codex', args: ['--task', 'x'] });
      expect(calls[0].opts.cwd).toBe(dir);
      expect(out.launches).toHaveLength(1);
      expect(out.launches[0]).toMatchObject({ providerId: 'codex', program: 'codex', by: 'owner-1', pid: 4242 });
      expect(await readLaunches(dir, runId)).toHaveLength(1);
      const run = await loadRun(dir, runId);
      expect(run.state).toBe('queued');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a copyable entry when no program is supplied', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir);
      const out = await launchExternalRun(dir, runId, { by: 'owner-1', providerId: 'codex' });
      expect(out.launched).toBe(false);
      expect(out.entry).toBe(buildExternalEntryCommand(TASK, 'xdo'));
      expect(out.entry).toContain(TASK);
      expect(await readLaunches(dir, runId)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses internal runs', async () => {
    const dir = root();
    try {
      const internal = await dispatchRun(dir, {
        taskUri: TASK, mode: 'xdo', taskContractHash: CONTRACT, inputs: [], closeout: 'commit-required',
      });
      expect(internal.ok).toBe(true);
      await expect(launchExternalRun(dir, internal.data.runId, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [],
      }, { spawn: fakeSpawn([]) })).rejects.toThrow('NOT_READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses verifying runs', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir, true);
      const token = (await readLease(dir, runId))?.token ?? '';
      await verifyRun(dir, runId, token, []);
      await expect(launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [],
      }, { spawn: fakeSpawn([]) })).rejects.toThrow('NOT_READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses cancelled runs', async () => {
    const dir = root();
    try {
      const cancelled = await externalRun(dir);
      expect((await cancelRun(dir, cancelled, null)).ok).toBe(true);
      await expect(launchExternalRun(dir, cancelled, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [],
      }, { spawn: fakeSpawn([]) })).rejects.toThrow('NOT_READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses foreign-owned runs', async () => {
    const dir = root();
    try {
      const owned = await externalRun(dir, true);
      expect((await takeoverRun(dir, owned, 'owner-2', 'taking over')).ok).toBe(true);
      await expect(launchExternalRun(dir, owned, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [],
      }, { spawn: fakeSpawn([]) })).rejects.toThrow('BUSY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses drifted baselines, bad programs, and escaping cwds', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir);
      const notePath = join(dir, '.agents', 'notes', 'task.md');
      const patched = readFileSync(notePath, 'utf8');
      writeFileSync(notePath, patched.replace('# External task', '# External task moved'));
      const calls: SpawnCall[] = [];
      await expect(launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [],
      }, { spawn: fakeSpawn(calls) })).rejects.toThrow('STALE_BASELINE');
      expect(calls).toHaveLength(0);
      writeFileSync(notePath, patched);
      const blank = await launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'p', program: '  ', args: [],
      }, { spawn: fakeSpawn(calls) });
      expect(blank.launched).toBe(false);
      expect(blank.entry).toContain(TASK);
      await expect(launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'p', program: 'x', args: ['ok', 42 as unknown as string],
      }, { spawn: fakeSpawn(calls) })).rejects.toThrow('SCHEMA_INVALID');
      await expect(launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'p', program: 'x', args: [], cwd: '../../..',
      }, { spawn: fakeSpawn(calls) })).rejects.toThrow('SCHEMA_INVALID');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends relaunch history without touching run state', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir, true);
      const calls: SpawnCall[] = [];
      await launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'codex', program: 'codex', args: ['a'],
      }, { spawn: fakeSpawn(calls, 11) });
      const second = await launchExternalRun(dir, runId, {
        by: 'owner-1', providerId: 'codex', program: 'codex', args: ['b'],
      }, { spawn: fakeSpawn(calls, 22) });
      expect(second.launched).toBe(true);
      expect(second.launches.map((row) => row.pid)).toEqual([11, 22]);
      expect((await loadRun(dir, runId)).state).toBe('running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launches through the controller after reattaching an external run', async () => {
    const dir = root();
    try {
      const runId = await externalRun(dir);
      const c = new HarnessController(() => dir, 'tester');
      const entered = await c.enter(TASK);
      expect(entered.stderr).toEqual([]);
      const calls: SpawnCall[] = [];
      const out = await c.launchExternal('codex', 'codex', ['--task'], { spawn: fakeSpawn(calls) });
      expect(out.stderr).toEqual([]);
      expect(out.stdout.join('')).toContain('launched codex');
      expect(out.stdout.join('')).toContain(runId.slice(0, 8));
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
