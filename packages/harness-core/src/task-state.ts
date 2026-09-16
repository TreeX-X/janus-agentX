/**
 * Task execution state machine (contract C3 operation table).
 * State writes never alter the contract hash; scope moves expire the
 * baseline instead (see hash.ts). Restart-after-unknown-owner needs an
 * explicit re-claim; this module never guesses success.
 */
import type { Diagnostic, ExecutionState, TaskExecution } from './schema.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

export type TaskOp =
  | 'prepare'
  | 'start'
  | 'verify'
  | 'finish'
  | 'repair'
  | 'pause'
  | 'resume'
  | 'rebaseline'
  | 'cancel'
  | 'stale'
  | 'restart';

export interface OpContext {
  lifecycle: string;
  workReady: boolean;
  baselineValid: boolean;
  dependenciesReady: boolean;
  authorized: boolean;
  leaseHeld: boolean;
  receiptReady: boolean;
  repairBudgetLeft: boolean;
  resumeFrom?: ExecutionState;
}

const TERMINAL: ExecutionState[] = ['done', 'cancelled'];

export function isTerminalState(s: ExecutionState): boolean {
  return TERMINAL.includes(s);
}

/** Legal op per state plus its premise checks. Returns problems, never throws. */
export function checkOp(current: ExecutionState | undefined, op: TaskOp, ctx: OpContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const need = (cond: boolean, code: Diagnostic['code'], message: string): void => {
    if (!cond) out.push(diag(code, message, 'execution'));
  };
  switch (op) {
    case 'prepare':
      need(current === undefined, 'SCHEMA_INVALID', 'prepare starts without execution');
      need(ctx.lifecycle === 'accepted', 'NOT_READY', 'task executes only from accepted');
      need(ctx.workReady, 'NOT_READY', 'work/acceptance/verification incomplete');
      need(ctx.baselineValid, 'STALE_BASELINE', 'inputs unresolvable at prepare');
      break;
    case 'start':
      need(current === 'queued', 'SCHEMA_INVALID', `start runs from queued (now ${String(current)})`);
      need(ctx.baselineValid, 'STALE_BASELINE', 'baseline expired before start');
      need(ctx.dependenciesReady, 'DEPENDENCY_UNSATISFIED', 'predecessors unmet');
      need(ctx.authorized, 'APPROVAL_REQUIRED', 'start needs authorization');
      need(ctx.leaseHeld, 'BUSY', 'another owner holds this task');
      break;
    case 'verify':
      need(current === 'running', 'SCHEMA_INVALID', `verify runs from running (now ${String(current)})`);
      break;
    case 'finish':
      need(current === 'verifying', 'SCHEMA_INVALID', `finish runs from verifying (now ${String(current)})`);
      need(ctx.receiptReady, 'NOT_READY', 'finish needs a valid receipt');
      break;
    case 'repair':
      need(
        current === 'verifying' || current === 'blocked',
        'SCHEMA_INVALID',
        `repair runs from verifying/blocked (now ${String(current)})`,
      );
      need(ctx.repairBudgetLeft, 'BUSY', 'repair budget spent');
      need(ctx.authorized, 'APPROVAL_REQUIRED', 'repair needs authorization');
      need(ctx.baselineValid, 'STALE_BASELINE', 'contract moved; rebaseline instead');
      break;
    case 'pause':
      need(
        current === 'queued' || current === 'running' || current === 'verifying',
        'SCHEMA_INVALID',
        `pause runs from queued/running/verifying (now ${String(current)})`,
      );
      break;
    case 'resume':
      need(current === 'paused', 'SCHEMA_INVALID', `resume runs from paused (now ${String(current)})`);
      need(ctx.baselineValid, 'STALE_BASELINE', 'baseline moved while paused');
      need(ctx.leaseHeld, 'BUSY', 're-claim the owner lease first');
      break;
    case 'rebaseline':
      need(
        current === 'blocked' || current === 'paused',
        'SCHEMA_INVALID',
        `rebaseline runs from blocked/paused (now ${String(current)})`,
      );
      need(ctx.authorized, 'APPROVAL_REQUIRED', 'rebaseline needs authorization');
      break;
    case 'cancel':
      need(current !== undefined && !isTerminalState(current), 'SCHEMA_INVALID', 'terminal states stay put');
      break;
    case 'stale':
    case 'restart':
      need(
        current === 'running' || current === 'verifying',
        'SCHEMA_INVALID',
        `${op} applies to running/verifying (now ${String(current)})`,
      );
      break;
    default:
      out.push(diag('SCHEMA_INVALID', `unknown op ${String(op)}`));
  }
  return out;
}

/** Next attempt number: start from 0 counts the first claim as 1. */
export function nextAttempt(exec: TaskExecution | undefined, op: 'start' | 'repair' | 'resume'): number {
  if (!exec) return op === 'start' ? 1 : 0;
  if (op === 'start' || op === 'repair') return exec.attempt + 1;
  return exec.attempt;
}
