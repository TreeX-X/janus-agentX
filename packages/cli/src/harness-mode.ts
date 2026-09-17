// Note: TUI harness mode lives here — see .agents/notes/implemented/architecture/2026-09-17-cli-harness-mode-s8.md
/**
 * @file TUI harness mode shell (S8 slice 8b-2, mode half).
 * @description Explicit task-bound mode for the interactive loop. Normal
 *  input stays the build-mode chat turn; `/harness <task>` binds one task
 *  note to one 8a run (fixed baseline, owner lease, handoff file) and the
 *  prompt shows the mode until `/exit` leaves it. Leaving never cancels:
 *  only an explicit cancel ends the run, and re-entering reattaches to the
 *  live run instead of dispatching a duplicate. Scoped turns, receipts,
 *  review, and CLI closeout arrive in later slices; this shell promises
 *  ownership and visibility only.
 */
import { hostname, userInfo } from 'node:os';
import {
  buildNoteIndex,
  collectTaskBaseline,
} from '@janus-agent/harness-node';
import {
  cancelRun,
  dispatchRun,
  handoffRun,
  listRuns,
  loadRun,
  pauseRun,
  readLease,
  startRun,
  takeoverRun,
} from '@janus-agent/janus-agent';
import type { CommandOutcome } from './tui/exec.js';

export interface HarnessHost {
  isActive(): boolean;
  run(args: string[]): Promise<CommandOutcome>;
  exitMode(): string[];
}

export interface HarnessModeSnapshot {
  active: boolean;
  root?: string;
  taskUri?: string;
  runId?: string;
  mode?: string;
  state?: string;
  attempt?: number;
}

interface Binding {
  root: string;
  taskUri: string;
  runId: string;
  mode: string;
}

const TERMINAL_RUN = new Set(['done', 'cancelled']);

function pretty(problems: Array<{ code: string; message: string }>): string[] {
  return problems.map((p) => `${p.code}: ${p.message}`);
}

/** Stable owner across CLI invocations on one machine; pid-excluded on purpose. */
export function cliOwner(): string {
  let user = 'unknown';
  try {
    user = userInfo().username || 'unknown';
  } catch {
    // Sandboxes without users keep the default.
  }
  let host = 'localhost';
  try {
    host = hostname() || 'localhost';
  } catch {
    // Keep the default.
  }
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  return `cli:${clean(user)}@${clean(host)}`;
}

export function harnessUsage(): string[] {
  return [
    'harness mode: task-bound runs with a fixed baseline and an owner lease.',
    '  /harness <task-uri|id|path> [--mode xdo|xdel|xflow]   enter (dispatches or reattaches)',
    '  /harness [status]                                      show the bound run',
    '  /harness pause | cancel | takeover <reason> | exit     run controls',
    '  /exit                                                  leave harness mode (the run keeps its lease)',
  ];
}

export class HarnessController {
  private binding: Binding | null = null;
  private pendingTakeover: Binding | null = null;

  constructor(
    private readonly workspaceRoot: () => string,
    private readonly owner: string = cliOwner(),
  ) {}

  isActive(): boolean {
    return this.binding !== null;
  }

  snapshot(): HarnessModeSnapshot {
    if (!this.binding) return { active: false };
    return { active: true, ...this.binding };
  }

  exitMode(): string[] {
    if (!this.binding) return ['harness mode is already off.'];
    this.binding = null;
    this.pendingTakeover = null;
    return ['left harness mode — back to build mode. The run keeps its lease; re-enter to reattach.'];
  }

  async enter(ref: string, opts: { mode?: string; maxAutoRepairs?: number } = {}): Promise<CommandOutcome> {
    const root = this.workspaceRoot();
    const mode = opts.mode ?? 'xdo';
    if (mode !== 'xdo' && mode !== 'xdel' && mode !== 'xflow') {
      return { stdout: [], stderr: [`janus: unknown harness mode "${mode}" (xdo|xdel|xflow).`] };
    }
    const collected = await collectTaskBaseline(root, ref).catch((e: unknown) => ({
      ok: false as const,
      problems: [{ code: 'IO_ERROR' as const, message: String(e) }],
    }));
    if (!collected.ok) return { stdout: [], stderr: pretty(collected.problems) };
    const { baseline } = collected;
    const live = await this.liveRun(root, baseline.taskUri);
    if (live) {
      const lease = await readLease(root, live.runId);
      if (lease && lease.owner === this.owner) {
        this.binding = { root, taskUri: baseline.taskUri, runId: live.runId, mode: live.mode };
        this.pendingTakeover = null;
        return { stdout: [`reattached run ${live.runId.slice(0, 8)} (${live.state}, attempt ${live.attempt}).`, ...(await this.describe(root, baseline.taskUri))] , stderr: [] };
      }
      this.pendingTakeover = { root, taskUri: baseline.taskUri, runId: live.runId, mode: live.mode };
      const holder = lease ? `held by ${lease.owner} since ${lease.since}` : 'lease file missing';
      return {
        stdout: [],
        stderr: [`janus: task already runs as ${live.runId.slice(0, 8)} (${holder}).`, '/harness takeover <reason> to take it explicitly, or wait.'],
      };
    }
    const dispatched = await dispatchRun(root, {
      taskUri: baseline.taskUri,
      mode,
      taskContractHash: baseline.taskContractHash,
      inputs: baseline.inputs,
      closeout: 'commit-required',
      maxAutoRepairs: opts.maxAutoRepairs ?? 1,
      executor: 'internal',
    });
    if (!dispatched.ok) return { stdout: [], stderr: pretty(dispatched.errors) };
    const started = await startRun(root, dispatched.data.runId, this.owner, {
      baselineValid: true,
      dependenciesReady: true,
      authorization: { by: this.owner },
    });
    if (!started.ok) {
      return { stdout: [], stderr: [...pretty(started.errors), `run ${dispatched.data.runId.slice(0, 8)} stays queued.`] };
    }
    const handoff = await handoffRun(root, dispatched.data.runId);
    this.binding = { root, taskUri: baseline.taskUri, runId: dispatched.data.runId, mode };
    this.pendingTakeover = null;
    return {
      stdout: [
        `harness mode: ${mode} · run ${dispatched.data.runId.slice(0, 8)} (attempt ${started.data.attempt}).`,
        ...(await this.describe(root, baseline.taskUri)),
        ...(handoff.ok ? [`handoff: ${handoff.data.path}`] : []),
      ],
      stderr: [],
    };
  }

  async status(): Promise<CommandOutcome> {
    if (!this.binding) return { stdout: ['harness mode is off — /harness <task-uri> to enter.'], stderr: [] };
    const { root, runId } = this.binding;
    let run;
    try {
      run = await loadRun(root, runId);
    } catch {
      this.binding = null;
      return { stdout: [], stderr: ['janus: run record is gone; left harness mode.'] };
    }
    const lease = await readLease(root, runId);
    return {
      stdout: [
        `run ${run.runId.slice(0, 8)} · ${run.state} · attempt ${run.attempt} · ${run.mode}`,
        `task ${run.taskUri}`,
        `contract ${run.baseline.taskContractHash.slice(0, 12)}… · ${run.baseline.inputs.length} pinned inputs`,
        `repair budget ${run.repairBudget.usedAuto}/${run.repairBudget.maxAuto} · receipts ${run.receipts.length} · closeout ${run.closeout}`,
        `lease ${lease ? `${lease.owner} since ${lease.since}` : '(none)'}`,
      ],
      stderr: [],
    };
  }

  async pause(): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    const token = await this.ownToken(bound.run.root, bound.run.runId);
    if (!token.ok) return token;
    const out = await pauseRun(bound.run.root, bound.run.runId, token.token);
    if (!out.ok) return { stdout: [], stderr: pretty(out.errors) };
    return { stdout: [`run paused (was ${out.run?.pausedFrom ?? 'active'}).`], stderr: [] };
  }

  async cancel(): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    const token = await this.ownToken(bound.run.root, bound.run.runId);
    if (!token.ok) return token;
    const out = await cancelRun(bound.run.root, bound.run.runId, token.token);
    if (!out.ok) return { stdout: [], stderr: pretty(out.errors) };
    const lines = [`run ${bound.run.runId.slice(0, 8)} cancelled.`, ...this.exitMode()];
    return { stdout: lines, stderr: [] };
  }

  async takeover(reason: string): Promise<CommandOutcome> {
    const target = this.binding ?? this.pendingTakeover;
    if (!target) return { stdout: [], stderr: ['janus: nothing to take over — enter a task first.'] };
    if (!reason.trim()) return { stdout: [], stderr: ['usage: /harness takeover <reason>'] };
    const out = await takeoverRun(target.root, target.runId, this.owner, reason.trim());
    if (!out.ok) return { stdout: [], stderr: pretty(out.errors) };
    this.binding = target;
    this.pendingTakeover = null;
    return { stdout: [`took over run ${target.runId.slice(0, 8)} (${reason.trim()}).`], stderr: [] };
  }

  private requireBinding(): { ok: true; run: Binding } | { ok: false; stdout: string[]; stderr: string[] } {
    if (!this.binding) return { ok: false, stdout: ['harness mode is off — /harness <task-uri> to enter.'], stderr: [] };
    return { ok: true, run: this.binding };
  }

  private async ownToken(root: string, runId: string): Promise<{ ok: true; token: string } | { ok: false; stdout: string[]; stderr: string[] }> {
    const lease = await readLease(root, runId);
    if (!lease || lease.owner !== this.owner) {
      return { ok: false, stdout: [], stderr: [`janus: lease is not ours (${lease ? `held by ${lease.owner}` : 'no lease file'}).`] };
    }
    return { ok: true, token: lease.token };
  }

  private async liveRun(root: string, taskUri: string) {
    const runs = await listRuns(root);
    return runs.find((r: { taskUri: string; state: string }) => r.taskUri === taskUri && !TERMINAL_RUN.has(r.state)) ?? null;
  }

  private async describe(root: string, taskUri: string): Promise<string[]> {
    try {
      const index = await buildNoteIndex(root);
      const id = taskUri.split('/').pop() ?? taskUri;
      const entry = index.byId.get(id);
      const note = entry?.note;
      if (!note) return [`task ${taskUri}`];
      const lines = [`task: ${note.title} [${note.meta.kind}/${note.meta.lifecycle}]`];
      if (note.acs.length > 0) {
        lines.push(`acceptance: ${note.acs.map((ac) => `${ac.id}${ac.checked ? ' (done)' : ''}`).join(', ')}`);
      }
      const scope = note.meta.work?.scope ?? [];
      if (scope.length > 0) {
        lines.push(`scope: ${scope.map((s) => `${s.repoId}:${s.paths.join(',')}`).join(' ')}`);
      }
      const verification = note.meta.work?.verification ?? [];
      if (verification.length > 0) {
        lines.push(`verification: ${verification.map((v) => v.id).join(', ')}`);
      }
      return lines;
    } catch {
      return [`task ${taskUri}`];
    }
  }
}

/** Shared-command adapter: one entry for the plain loop; Ink passes no host until wired. */
export function createHarnessHost(controller: HarnessController): {
  isActive(): boolean;
  run(args: string[]): Promise<CommandOutcome>;
  exitMode(): string[];
} {
  const takeFlag = (argv: string[], name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  return {
    isActive: () => controller.isActive(),
    exitMode: () => controller.exitMode(),
    run: async (rawArgs: string[]): Promise<CommandOutcome> => {
      const argv = [...rawArgs];
      const [first, ...rest] = argv;
      if (!first || first === 'status') return controller.status();
      if (first === 'pause') return controller.pause();
      if (first === 'cancel') return controller.cancel();
      if (first === 'takeover') return controller.takeover(rest.join(' '));
      if (first === 'exit') return { stdout: controller.exitMode(), stderr: [] };
      if (first === 'enter' || !first.startsWith('-')) {
        const ref = first === 'enter' ? rest.shift() : first;
        if (!ref) {
          return { stdout: [], stderr: ['usage: /harness <task-uri|id|path> [--mode xdo|xdel|xflow] [--max-auto N]'] };
        }
        const restArgs = first === 'enter' ? rest : argv.slice(1);
        const mode = takeFlag(restArgs, '--mode');
        const maxAuto = takeFlag(restArgs, '--max-auto');
        const maxAutoRepairs = maxAuto !== undefined ? Number(maxAuto) : undefined;
        if (maxAutoRepairs !== undefined && (!Number.isInteger(maxAutoRepairs) || maxAutoRepairs < 0)) {
          return { stdout: [], stderr: ['janus: --max-auto must be a non-negative integer.'] };
        }
        return controller.enter(ref, { ...(mode ? { mode } : {}), ...(maxAutoRepairs !== undefined ? { maxAutoRepairs } : {}) });
      }
      return { stdout: [], stderr: ['usage: /harness <task-uri|id|path> [--mode xdo|xdel|xflow] [--max-auto N]'] };
    },
  };
}
