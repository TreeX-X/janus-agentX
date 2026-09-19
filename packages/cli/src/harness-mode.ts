// Note: TUI harness mode lives here — see .agents/notes/implemented/architecture/2026-09-17-cli-harness-mode-s8.md
/**
 * @file Task-bound plain CLI execution and lifecycle controls.
 * @description Leaving the mode keeps the lease. Re-entry rechecks the
 *  baseline; task turns, verification, review and receipts use the shared
 *  execution host. Ink and plain CLI each own a controller behind the shared adapter.
 */
import { hostname, userInfo } from 'node:os';
import {
  buildNoteIndex,
  collectTaskBaseline,
  readTaskResult,
} from '@janus-agent/harness-node';
import {
  cancelRun,
  closeoutRun,
  dispatchRun,
  executeTaskExecution,
  handoffRun,
  listRuns,
  loadRun,
  maybeAutoRepair,
  pauseRun,
  prepareTaskTurn,
  rebaselineRun,
  repairRun,
  resumeRun,
  readLease,
  startRun,
  takeoverRun,
  verifyTaskExecution,
  type TaskTurnContext,
  type TaskVerificationPorts,
} from '@janus-agent/janus-agent';
import { launchExternalRun, type SpawnFn } from './external-runner.js';
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

function sameBaseline(a: { taskContractHash: string; inputs: Array<{ uri: string; contentHash: string; criteria?: string[] }> }, b: typeof a): boolean {
  const key = (inputs: typeof a.inputs) => JSON.stringify(inputs.map((row) => [row.uri, row.contentHash, [...(row.criteria ?? [])].sort()]).sort());
  return a.taskContractHash === b.taskContractHash && key(a.inputs) === key(b.inputs);
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
    '  /harness start | pause | resume | cancel | takeover <reason> | exit',
    '  /harness execute | verify | repair <reason> | rebaseline | closeout',
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
    const portable = await readTaskResult(root, ref);
    if (portable.execution && TERMINAL_RUN.has(portable.execution.state)) {
      return { stdout: [`task ${portable.taskUri}: ${portable.execution.state}; evidence ${portable.validity}; closeout ${portable.execution.closeout}`,
        `wfx-notes result ${portable.taskUri} --closeout`], stderr: pretty(portable.errors) };
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
      if (lease?.owner === this.owner || (!lease && live.state === 'queued')) {
        if (!sameBaseline(live.baseline, baseline)) {
          this.binding = { root, taskUri: baseline.taskUri, runId: live.runId, mode: live.mode };
          this.pendingTakeover = null;
          return { stdout: [], stderr: ['STALE_BASELINE: task changed; pause and explicitly rebaseline before execution.'] };
        }
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
    const result = await readTaskResult(root, run.taskUri);
    return {
      stdout: [
        `run ${run.runId.slice(0, 8)} · ${run.state} · attempt ${run.attempt} · ${run.mode}`,
        `task ${run.taskUri}`,
        `contract ${run.baseline.taskContractHash.slice(0, 12)}… · ${run.baseline.inputs.length} pinned inputs`,
        `repair budget ${run.repairBudget.usedAuto}/${run.repairBudget.maxAuto} · receipts ${run.receipts.length} · closeout ${run.closeout}`,
        `lease ${lease ? `${lease.owner} since ${lease.since}` : '(none)'}`,
        `evidence ${result.validity}`,
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

  // Note: task turns never complete from model prose - see .agents/notes/implemented/architecture/2026-09-18-harness-task-execution.md
  async executeTurn<T extends { cancelled: boolean }>(send: (context: TaskTurnContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const bound = this.requireBinding();
    if (!bound.ok) throw new Error([...bound.stdout, ...bound.stderr].join('\n'));
    const token = await this.ownToken(bound.run.root, bound.run.runId);
    if (!token.ok) throw new Error(token.stderr.join('\n'));
    try {
      signal?.throwIfAborted();
      const result = await send(await prepareTaskTurn(bound.run.root, bound.run.runId, token.token));
      if (result.cancelled || signal?.aborted) await this.pause();
      return result;
    } catch (error) {
      if (signal?.aborted) await this.pause();
      throw error;
    }
  }

  async control(command: 'start' | 'resume' | 'rebaseline' | 'repair' | 'closeout', reason = ''): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    const { root, runId, taskUri } = bound.run;
    if (command === 'closeout') {
      const result = await closeoutRun(root, runId, { repoRoot: root });
      return { stdout: result.ok ? [result.data.detail] : [], stderr: pretty(result.errors) };
    }
    if (command === 'start') {
      const fresh = await collectTaskBaseline(root, taskUri);
      if (!fresh.ok) return { stdout: [], stderr: pretty(fresh.problems) };
      const run = await loadRun(root, runId);
      const result = await startRun(root, runId, this.owner, {
        baselineValid: sameBaseline(fresh.baseline, run.baseline),
        dependenciesReady: true, authorization: { by: this.owner },
      });
      return { stdout: result.ok ? [`run started (attempt ${result.data.attempt}).`] : [], stderr: pretty(result.errors) };
    }
    const token = await this.ownToken(root, runId);
    if (!token.ok) return token;
    if (command === 'resume') {
      const fresh = await collectTaskBaseline(root, taskUri);
      if (!fresh.ok) return { stdout: [], stderr: pretty(fresh.problems) };
      if (!sameBaseline(fresh.baseline, (await loadRun(root, runId)).baseline)) return { stdout: [], stderr: ['STALE_BASELINE: task changed; rebaseline before resuming.'] };
      const result = await resumeRun(root, runId, token.token);
      return { stdout: result.ok ? [`run resumed (${result.data.state}).`] : [], stderr: pretty(result.errors) };
    }
    if (command === 'rebaseline') {
      const fresh = await collectTaskBaseline(root, taskUri);
      if (!fresh.ok) return { stdout: [], stderr: pretty(fresh.problems) };
      const result = await rebaselineRun(root, runId, token.token, fresh.baseline, { by: this.owner });
      return { stdout: result.ok ? ['baseline updated; /harness start to execute it.'] : [], stderr: pretty(result.errors) };
    }
    if (!reason.trim()) return { stdout: [], stderr: ['usage: /harness repair <reason>'] };
    const run = await loadRun(root, runId);
    const receiptId = run.receipts.at(-1);
    if (!receiptId) return { stdout: [], stderr: ['NOT_READY: repair requires a recorded failure receipt'] };
    const result = await repairRun(root, runId, token.token, { failureReceiptId: receiptId, summary: reason, auto: false, authorization: { by: this.owner } });
    return { stdout: result.ok ? [`repair started (attempt ${result.data.attempt}).`] : [], stderr: pretty(result.errors) };
  }

  async verify(ports: (actor: string) => TaskVerificationPorts, signal?: AbortSignal): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    const token = await this.ownToken(bound.run.root, bound.run.runId);
    if (!token.ok) return token;
    try {
      const result = await verifyTaskExecution(bound.run.root, bound.run.runId, token.token, ports(this.owner), signal);
      const summary = `receipt ${result.receipt.id}: ${result.completed ? 'done; closeout remains separate' : 'not complete'}`;
      if (result.completed) return { stdout: [summary], stderr: result.errors };
      const auto = await maybeAutoRepair(bound.run.root, bound.run.runId, token.token);
      if (auto.ok && auto.data.repaired) {
        return { stdout: [summary, `auto repair started (attempt ${auto.data.attempt}).`], stderr: result.errors };
      }
      return { stdout: [summary], stderr: result.errors };
    } catch (error) { return { stdout: [], stderr: [String(error)] }; }
  }

  async execute(ports: (actor: string) => TaskVerificationPorts,
    implement: (turn: TaskTurnContext, signal?: AbortSignal) => Promise<{ cancelled: boolean }>, signal?: AbortSignal): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    const token = await this.ownToken(bound.run.root, bound.run.runId);
    if (!token.ok) return token;
    try {
      const result = await executeTaskExecution(bound.run.root, bound.run.runId, token.token, { ...ports(this.owner), implement }, signal);
      return { stdout: [`receipt ${result.receipt.id}: ${result.completed ? 'done; closeout remains separate' : 'not complete'}`], stderr: result.errors };
    } catch (error) { return { stdout: [], stderr: [String(error)] }; }
  }

  async launchExternal(providerId: string, program: string | undefined, args: string[], opts?: { spawn?: SpawnFn }): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    try {
      const launched = await launchExternalRun(bound.run.root, bound.run.runId, {
        by: this.owner, providerId, ...(program ? { program, args } : {}),
      }, opts);
      if (!launched.launched) {
        return { stdout: ['external entry (copy into a terminal):', ...(launched.entry ? [launched.entry] : [])], stderr: [] };
      }
      return { stdout: [`launched ${program} (pid ${launched.pid ?? 'unknown'}) for run ${bound.run.runId.slice(0, 8)}.`, 'process exit is an event only; evidence lands as files.'], stderr: [] };
    } catch (error) { return { stdout: [], stderr: [String(error)] }; }
  }

  async cancel(): Promise<CommandOutcome> {
    const bound = this.requireBinding();
    if (!bound.ok) return bound;
    if ((await loadRun(bound.run.root, bound.run.runId)).state === 'queued') {
      const out = await cancelRun(bound.run.root, bound.run.runId, null);
      return { stdout: out.ok ? ['queued run cancelled.', ...this.exitMode()] : [], stderr: pretty(out.errors) };
    }
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
    if (this.workspaceRoot() !== this.binding.root) return { ok: false, stdout: [], stderr: ['NOT_READY: workspace changed; re-enter the task'] };
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
        lines.push(`acceptance: ${note.acs.map((ac) => ac.id).join(', ')}`);
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

/** Shared-command adapter for the plain loop and Ink. */
export function createHarnessHost(controller: HarnessController, execution?: {
  ports: (actor: string) => TaskVerificationPorts;
  signal: () => AbortSignal | undefined;
  implement?: (turn: TaskTurnContext, signal?: AbortSignal) => Promise<{ cancelled: boolean }>;
}): {
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
      if (first === 'start' || first === 'resume' || first === 'rebaseline' || first === 'repair' || first === 'closeout') return controller.control(first, rest.join(' '));
      if (first === 'verify') return execution ? controller.verify(execution.ports, execution.signal()) : { stdout: [], stderr: ['CAPABILITY_UNAVAILABLE: no task execution host'] };
      if (first === 'execute') return execution?.implement ? controller.execute(execution.ports, execution.implement, execution.signal()) : { stdout: [], stderr: ['CAPABILITY_UNAVAILABLE: no task implementation host'] };
      if (first === 'cancel') return controller.cancel();
      if (first === 'launch') {
        const launchArgs = [...rest];
        const providerId = takeFlag(launchArgs, '--provider') ?? 'external';
        const dash = launchArgs.indexOf('--');
        const command = dash >= 0 ? launchArgs.slice(dash + 1) : [];
        return controller.launchExternal(providerId, command[0], command.slice(1));
      }
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
