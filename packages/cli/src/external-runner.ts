// Note: external process launch lives here — see .agents/notes/implemented/architecture/2026-09-19-external-runner-launch.md
/**
 * @file External runner launch (T2).
 * @description Spawns an external terminal process for a run prepared with
 *  the external executor, or hands back a copyable entry command when the
 *  caller supplies no program. The caller resolves the provider to a
 *  program plus argument array; this module never shells out and never
 *  guesses CLI syntax. Launch never mutates run state: process exit is an
 *  event, and only files plus the shared kernel decide evidence. Every
 *  spawn is recorded to the run-local launch history for later inspection.
 */
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { collectTaskBaseline } from '@janus-agent/harness-node';
import { loadRun, readLaunches, recordLaunch, type LaunchRecord } from '@janus-agent/janus-agent';

export interface ExternalLaunchRequest {
  by: string;
  providerId: string;
  program?: string;
  args?: string[];
  cwd?: string;
}

export interface ExternalLaunchOutcome {
  launched: boolean;
  pid?: number | null;
  command?: string[];
  entry?: string;
  launches: LaunchRecord[];
}

export type SpawnFn = (program: string, args: string[], opts: { cwd: string; detached: boolean }) => { pid?: number | null };

const defaultSpawn: SpawnFn = (program, args, opts) => {
  const child = spawn(program, args, { cwd: opts.cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid ?? null };
};

function sameBaseline(
  current: { taskContractHash: string; inputs: Array<{ uri: string; contentHash: string; criteria?: string[] }> },
  pinned: typeof current,
): boolean {
  const key = (inputs: typeof current.inputs) => JSON.stringify(inputs.map((row) => [row.uri, row.contentHash, [...(row.criteria ?? [])].sort()]).sort());
  return current.taskContractHash === pinned.taskContractHash && key(current.inputs) === key(pinned.inputs);
}

/** Copyable REPL entry, same shape the desktop panel shows beside its handoff. */
export function buildExternalEntryCommand(taskUri: string, mode: string): string {
  return `janus /harness ${taskUri} --mode ${mode}`;
}

function resolveCwd(root: string, cwd: string | undefined): string {
  if (!cwd || cwd === '.') return root;
  if (cwd.includes('\0')) throw new Error('SCHEMA_INVALID: launch cwd is empty');
  const abs = resolve(root, cwd);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('SCHEMA_INVALID: launch cwd escapes the checkout');
  return abs;
}

export async function launchExternalRun(
  root: string,
  runId: string,
  request: ExternalLaunchRequest,
  opts?: { spawn?: SpawnFn },
): Promise<ExternalLaunchOutcome> {
  const run = await loadRun(root, runId);
  if (run.executor !== 'external') {
    throw new Error(`NOT_READY: run ${runId.slice(0, 8)} uses the ${run.executor} executor; external launch needs an external run`);
  }
  if (run.state !== 'queued' && run.state !== 'running') {
    throw new Error(`NOT_READY: launch needs a queued or running run (now ${run.state})`);
  }
  if (run.lease && run.lease.owner !== request.by) {
    throw new Error(`BUSY: run is owned by ${run.lease.owner}; take over explicitly before launching`);
  }
  const collected = await collectTaskBaseline(root, run.taskUri).catch((e: unknown) => ({
    ok: false as const,
    problems: [{ code: 'IO_ERROR' as const, message: String(e) }],
  }));
  if (!collected.ok) {
    throw new Error((collected.problems ?? []).map((p) => `${p.code}: ${p.message}`).join('\n') || 'IO_ERROR: task baseline is unreadable');
  }
  if (!sameBaseline(collected.baseline, run.baseline)) {
    throw new Error('STALE_BASELINE: task changed; rebaseline before launching an external process.');
  }
  const launches = await readLaunches(root, runId);
  if (!request.program?.trim()) {
    return { launched: false, entry: buildExternalEntryCommand(run.taskUri, run.mode), launches };
  }
  const program = request.program.trim();
  const args = request.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('SCHEMA_INVALID: launch args must be a string array; shell strings are never executed');
  }
  const cwd = resolveCwd(root, request.cwd);
  const spawnFn = opts?.spawn ?? defaultSpawn;
  let pid: number | null;
  try {
    pid = spawnFn(program, args, { cwd, detached: true })?.pid ?? null;
  } catch (error) {
    throw new Error(`IO_ERROR: external spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record: LaunchRecord = {
    providerId: request.providerId, program, args, pid, by: request.by, at: new Date().toISOString(),
  };
  await recordLaunch(root, runId, record);
  return { launched: true, pid, command: [program, ...args], launches: [...launches, record] };
}
