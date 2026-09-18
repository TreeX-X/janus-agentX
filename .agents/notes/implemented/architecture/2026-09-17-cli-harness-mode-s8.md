# Agent Note: CLI harness mode shell

Status: implemented

## Problem

Interactive task work needs an explicit task binding, a pinned baseline,
and an owner. Without a reattachable mode, each invocation can dispatch
another run and the user cannot distinguish ordinary chat from task work.

## Decision

`/harness <task-uri|id|path>` binds one task note to one dispatch-kernel
run through `HarnessController`: shared baseline collection proves
readiness, dispatch plus start claim the owner lease under a stable
per-machine CLI identity, and a handoff file lands beside the run.
Re-entering reattaches to the live run instead of dispatching a
duplicate; a foreign lease refuses with the holder named and only an
explicit `/harness takeover <reason>` moves it. `/harness status|pause|
resume|cancel` drive the kernel ops, `/exit` leaves the mode without touching
the run or its lease, and only an explicit cancel ends it. The prompt
shows `harness>` in mode, and a workspace switch exits the mode loudly
rather than enforcing a baseline from the wrong directory. The slash
executor carries an optional harness host, so Ink reports the mode
unavailable until its loop is wired. Bound plain-loop turns and explicit
verification use [task-scoped execution](2026-09-18-harness-task-execution.md),
which owns tool policy, isolated history, receipts, review and recovery.

## Alternatives considered

- argv-only harness commands without a mode — strongest case is
  scriptability with no loop changes, but interactive task work then has
  no visible binding, no prompt, and no reattach story; the mode is the
  requested shape and argv stays for notes only.
- Auto-enter on task mentions — strongest case is zero commands to learn,
  but implicit mode switches surprise, and leases must never follow
  guesses; entry stays an explicit command.
- Cancel the run on mode exit — strongest case is no orphaned leases, but
  leaving a view is not abandoning the work; only explicit cancel ends a
  run, and takeover covers dead owners.
- Share the plain-loop controller directly with Ink — this offers both
  surfaces the same commands, but Ink owns its session replacement and
  rendering. It needs an explicit host adapter before enabling execution.
- Do nothing / reuse — keep build mode only; rejected because task work
  then has no bound baseline, no owner, and no duplicate protection.

## Consequences

- **Gains**: an explicit, reattachable task mode beside build mode.
  `npm test --workspace=@janus-agent/cli -- tests/harness-mode.test.ts`
  passes 15 checks covering ownership, command routing, scoped execution,
  isolated history, verification, cancellation and recovery.
- **Costs and limits**: the task execution host supports internal xdo in
  one checkout; delegated and manual evidence capabilities remain unavailable.
  The Ink loop reports the mode
  unavailable until wired. Predecessor coverage re-scans evidence per
  enter; large graphs pay a linear scan. Revisit with the Ink host and
  cross-checkout execution.
