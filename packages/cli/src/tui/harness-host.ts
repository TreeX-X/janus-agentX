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
import type { TaskTurnContext, TaskVerificationPorts } from '@janus-agent/janus-agent';
import type { HarnessHost } from './exec.js';

export interface InkHarnessSession {
  getWorkspaceRoot(): string;
  taskVerificationPorts(actor: string): TaskVerificationPorts;
  sendTurn?(prompt: string, callbacks: {}, signal?: AbortSignal, task?: TaskTurnContext): Promise<{ cancelled: boolean }>;
}

export interface InkHarnessHost extends HarnessHost {
  executeTurn<T extends { cancelled: boolean }>(send: (task?: TaskTurnContext) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createInkHarnessHost(deps: {
  session: () => InkHarnessSession;
  signal: () => AbortSignal | undefined;
  owner?: string;
  ports?: (actor: string, session: InkHarnessSession) => TaskVerificationPorts;
}): InkHarnessHost {
  const controller = deps.owner !== undefined
    ? new HarnessController(() => deps.session().getWorkspaceRoot(), deps.owner)
    : new HarnessController(() => deps.session().getWorkspaceRoot());
  return {
    ...createHarnessHost(controller, {
      ports: (actor) => deps.ports ? deps.ports(actor, deps.session()) : deps.session().taskVerificationPorts(actor),
      signal: deps.signal,
      implement: async (turn, signal) => {
        const session = deps.session();
        if (!session.sendTurn) throw new Error('CAPABILITY_UNAVAILABLE: no task implementation model');
        return session.sendTurn('Implement the accepted task. Read the relevant files, make scoped edits, and address the failure receipt on repair. The host runs checks and review.', {}, signal, turn);
      },
    }),
    executeTurn: (send, signal) => controller.isActive() ? controller.executeTurn(send, signal) : send(),
  };
}
