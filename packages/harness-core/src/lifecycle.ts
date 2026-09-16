/**
 * Lifecycle transitions (contract C2). Pure table plus the two guards
 * that need caller context: task archiving and decision grounding.
 */
import type { Diagnostic, ExecutionState, Lifecycle, NoteKind } from './schema.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

const EDGES: Record<string, Lifecycle[]> = {
  draft: ['proposed', 'rejected'],
  proposed: ['accepted', 'rejected'],
  accepted: ['proposed', 'archived', 'implemented'],
  implemented: ['archived'],
  rejected: [],
  archived: [],
};

export interface TransitionContext {
  kind: NoteKind;
  /** Current execution state for task notes (absent means no execution). */
  executionState?: ExecutionState;
  /** Explicit adopt/revoke authorization present. */
  authorized: boolean;
  /** Running tasks still reference this note (blocks adopt-revoke). */
  referencedByRunning?: boolean;
}

/** Machine-checkable transition. Empty array means allowed. */
export function checkLifecycle(from: Lifecycle, to: Lifecycle, ctx: TransitionContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (from === to) return out;
  if (!(EDGES[from] ?? []).includes(to)) {
    return [diag('SCHEMA_INVALID', `lifecycle ${from} -> ${to} forbidden`)];
  }
  if (to === 'implemented' && ctx.kind !== 'decision') {
    out.push(diag('SCHEMA_INVALID', 'implemented only for decision'));
  }
  if ((to === 'accepted' || (from === 'accepted' && to === 'proposed')) && !ctx.authorized) {
    out.push(diag('APPROVAL_REQUIRED', 'adopt/revoke needs authorization'));
  }
  if (from === 'accepted' && to === 'proposed' && ctx.referencedByRunning) {
    out.push(diag('BUSY', 'running tasks pin the accepted revision'));
  }
  if (ctx.kind === 'task' && to === 'archived') {
    const s = ctx.executionState;
    if (s !== undefined && s !== 'done' && s !== 'cancelled') {
      out.push(diag('BUSY', `task archives only without execution or at done/cancelled (now ${s})`));
    }
  }
  return out;
}
