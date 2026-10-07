---
{
  "schema": "harness-note/2",
  "id": "6af9ceb4-acd9-4818-ba67-374a06c897bc",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-17",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ea2ff74a-384a-432f-8938-89ba3dcf6f09",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-17-harness-dispatch-s8.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "c8f4ef24006ce170b0e7d0f024643d9845700b6ddc120f29e2d329f16e3b17e3",
      "historical": true
    }
  }
}
---

# Agent Note: Harness execution dispatch kernel

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

Transitions, receipt validity, hashes, and Git evidence exist as pure
verdicts, but nothing owns a run: no owner leases, no repair budgets, no
handoff files, and no landing proof. Without an owner, crashed writes
leave ambiguous states, two executors silently share one task, automatic
repairs loop without a budget, and external terminals have no fixed
baseline to continue from. Each future runner would reinvent ownership
and drift on the first conflict.

## Decision

`packages/janus-agent/src/harness/` owns run records from dispatch to
closeout. `run-store.ts` keeps local-only records under
`.agents/.local/runs/<runId>/`: state, attempt, lease, baseline, repair
budget and packets, receipt references, takeovers, and closeout strategy. Formal receipts and task execution use the [portable asset transaction](../../storage/history/harness-portable-results.md); leases use exclusive creation and never
auto-expire. `dispatcher.ts` runs every op through the shared `checkOp`
table and returns diagnostics instead of throwing for contract
violations. Start claims the lease before checking premises and releases
it when premises fail. Finish evaluates the recorded receipt against a
caller-supplied live snapshot, so drifted contracts, inputs, criteria, or
code stay verifying instead of completing. Automatic repairs consume the
budget (default one); authorized manual repairs do not. Takeover is
explicit, recorded, and also covers paused runs, because a lost lease
file must not strand a run that only needs a re-claim. Cancel and
terminal states release the lease. Closeout proves landing through the
Git primitives: a HEAD-reachable tree must contain the task contract, receipt and matching code manifest, and drifted
worktrees fail closed; working-tree strategy needs an authorization
reference plus a matching tree. `handoff.md` carries ids, hashes, budget,
and the local-only lease token with the rules for coming back, and
promises no CLI syntax.

## Alternatives considered

- Adopt the persistent-subagent thread model now — strongest case is
  context-preserving repair without re-reads, but the contract defines
  repair as a budgeted new attempt and reserves full thread lifecycles
  for a separate task; hosts may still use threads internally as long as
  attempts, budgets, and receipts follow this kernel.
- Keep ownership per host behind a shared checklist — strongest case is
  zero new packages, but checklists drift and the first real conflict
  writes two winners; one kernel makes double-lease impossible.
- Back runs with a database or service — strongest case is stronger
  concurrency, but offline terminals and plain git checkouts become
  second-class runners, against the file-first goal.
- Build the CLI surface first — strongest case is visible progress, but a
  surface without an ownership kernel encodes guesses the kernel later
  breaks; the kernel lands first, `janus notes` and `janus harness run`
  adapt to it next.
- Do nothing / reuse — keep session todos as the only tracker; rejected
  because todos evaporate with the session and cannot gate a second
  executor, a budget, or a landing proof.

## Consequences

- **Gains**: one owner per run with budgeted repair and provable landing.
  Verification: `packages/janus-agent/tests/harness-dispatch.test.ts`
  (11 checks: dispatch validation, dispatch-to-done with lease release
  and handoff, xflow independent review with same-actor refusal, auto
  budget with authorized manual repair, single lease with explicit
  takeover, drift staying verifying, pause/resume/rebaseline/cancel plus
  terminal guards, unknown-run NOT_FOUND, commit landing proof, drifted
  and unlanded refusal, working-tree authorization gate), package suite
  green (46 checks), `npm run typecheck` and `npm run build` pass for the
  workspace.
- **Costs and limits**: no model, shell, CLI, or UI wiring — runners call
  this kernel and bring their own live snapshots. Run records are
  local coordination records written alongside formal assets by the shared journal. Historical results rebuild from task
  notes plus receipts and never grant local execution ownership. Closeout examines current-branch candidates and assumes the single-write-repo
  contract; multi-repo work coordinates through multiple runs. Revisit
  when the CLI adapter, the built-in runner, or persistent threads land.
