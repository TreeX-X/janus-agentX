// Note: Ink harness host lives here — see .agents/notes/implemented/architecture/2026-09-19-ink-harness-host.md
/**
 * @file Ink harness host (T1).
 * @description Binds the task-bound harness controller to the Ink loop.
 *  The controller instance belongs to Ink: workspace root, ports, and
 *  abort signal all read the live Ink session through accessors, so
 *  workspace switches and session replacement never strand the binding.
 *  Command semantics stay in the shared adapter — this file only owns
 *  the Ink side of the host contract.
 */
import { HarnessController, createHarnessHost } from '../harness-mode.js';
import type { TaskVerificationPorts } from '@janus-agent/janus-agent';
import type { HarnessHost } from './exec.js';

export interface InkHarnessSession {
  getWorkspaceRoot(): string;
  taskVerificationPorts(actor: string): TaskVerificationPorts;
}

export function createInkHarnessHost(deps: {
  session: () => InkHarnessSession;
  signal: () => AbortSignal | undefined;
  owner?: string;
  ports?: (actor: string, session: InkHarnessSession) => TaskVerificationPorts;
}): HarnessHost {
  const controller = deps.owner !== undefined
    ? new HarnessController(() => deps.session().getWorkspaceRoot(), deps.owner)
    : new HarnessController(() => deps.session().getWorkspaceRoot());
  return createHarnessHost(controller, {
    ports: (actor) => deps.ports ? deps.ports(actor, deps.session()) : deps.session().taskVerificationPorts(actor),
    signal: deps.signal,
  });
}
