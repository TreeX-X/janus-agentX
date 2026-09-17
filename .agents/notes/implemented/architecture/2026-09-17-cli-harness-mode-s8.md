# Agent Note: CLI harness mode shell

Status: implemented

## Problem

The CLI runs every turn in build mode: one conversation, full tools, no
task binding, no baseline, no owner. Starting task-bound work meant
hand-assembling dispatcher calls with hand-pinned hashes, and two
invocations silently dispatched duplicate runs for one task. There was no
explicit, switchable harness mode — only the uniform chat loop the mode
is supposed to stand beside.

## Decision

`/harness <task-uri|id|path>` binds one task note to one dispatch-kernel
run through `HarnessController`: shared baseline collection proves
readiness, dispatch plus start claim the owner lease under a stable
per-machine CLI identity, and a handoff file lands beside the run.
Re-entering reattaches to the live run instead of dispatching a
duplicate; a foreign lease refuses with the holder named and only an
explicit `/harness takeover <reason>` moves it. `/harness status|pause|
cancel` drive the kernel ops, `/exit` leaves the mode without touching
the run or its lease, and only an explicit cancel ends it. The prompt
shows `harness>` in mode, and a workspace switch exits the mode loudly
rather than enforcing a baseline from the wrong directory. The slash
executor carries an optional harness host, so Ink reports the mode
unavailable until its loop is wired instead of failing. Turns themselves
are unchanged in this slice: same chat turns, with scoping, receipts,
review, and CLI closeout arriving next.

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
- Wire the Ink loop in the same change — strongest case is both loops at
  once, but the Ink host owns its own session replacement and rendering;
  the shared executor already routes the command, and the host half stays
  a separate, reviewable slice.
- Do nothing / reuse — keep build mode only; rejected because task work
  then has no bound baseline, no owner, and no duplicate protection.

## Consequences

- **Gains**: an explicit, reattachable task mode beside build mode.
  Verification: `packages/cli/tests/harness-mode.test.ts` (7 checks:
  owner shape, enter card with run binding, duplicate-free reattach,
  pause/cancel with lease-preserving exit, foreign-lease takeover,
  named refusals, host routing with usage and exit),
  twin-updated exec/command/composer suites stay green (CLI package 370
  checks), `npm run typecheck` and `npm run build` pass.
- **Costs and limits**: turns in mode are ordinary chat turns — no task
  scoping, no automatic receipts, no review, no CLI closeout; the mode
  promises ownership and visibility only. The Ink loop reports the mode
  unavailable until wired. Predecessor coverage re-scans evidence per
  enter; large graphs pay a linear scan. Revisit with scoped turns,
  receipts and review, CLI closeout, and the Ink host.
