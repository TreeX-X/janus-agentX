# Agent Note: Automatic repair scheduling spends the budget

Status: implemented

## Problem

The dispatch kernel tracks an automatic repair budget per run, but no production path spends it: the only repair caller passes `auto: false`, and `auto: true` appears solely in kernel tests. A run that records failed required checks sits in `verifying` until a human notices, runs the same manual repair command, and reopens the attempt. The budget, the packet shape, and the attempt accounting exist without a scheduler.

## Decision

`maybeAutoRepair` in `packages/janus-agent/src/harness/dispatcher.ts` spends one unit of automatic budget when the live attempt records failed required checks, or an xflow independent review records needs-fix. xdel never automatically reopens; blocked review evidence also refuses automatic repair. The [delegated execution policy](2026-09-19-delegated-task-hosts.md) owns role identity and the complete host loops. It re-derives failure from the latest receipt instead of parsing host strings, and it skips without touching the run when the state is not `verifying`, no eligible failure exists, the evidence belongs to an older attempt, or the budget is spent; foreign leases fail loudly. The repair itself reuses `repairRun`, so lease, budget, and state gates stay authoritative, and the summary names the failed checks so the next attempt inherits the failure context through the standard packet. Mode gates still apply downstream: reopening never skips self or independent review. The CLI `verify` path calls it after an uncompleted verification and reports `auto repair started (attempt N)`; desktop and other hosts adopt the same call on their own schedule.

## Alternatives considered

- Poll or watch runs for failures: reacts without a host round-trip, but adds a background owner beside the lease system and risks acting on runs another host is already handling; the explicit call after verify keeps one owner.
- Trigger on any unfinished run: simpler predicate, but reopens runs whose evidence is stale or whose failure is infra-level; the failed-check plus attempt-match predicate limits auto action to genuine check failures.
- Auto-repair inside `verifyTaskExecution` for every host: one place, but silently changes desktop behavior across repositories; hosts stay peers and opt in explicitly, starting with the CLI.
- Keep repairs manual only: zero new behavior, but the budget fields stay decorative and every failed run waits on human polling despite carrying machine-readable failure evidence.
- Do nothing / reuse — leave failures parked in `verifying`; rejected because the kernel already promises a bounded automatic repair policy it never executes.

## Consequences

- **Gains**: failed xdo runs reopen once automatically with the failure context attached; spent budgets park visibly with manual repair still available. Verification: `packages/janus-agent/tests/harness-auto-repair.test.ts` (5 checks: single repair with named packet, budget exhaustion with manual fallback, clean-receipt skip, older-attempt skip, wrong-state and foreign-lease refusal) and a CLI end-to-end case (failed command verification auto-repairs once, then stops at spent budget). Existing dispatch, task-execution, and CLI harness suites stay green; workspace typecheck and the `janus-agent` build pass.
- **Costs and limits**: at most one automatic reopen per run by default; anything needing a second automatic attempt waits on an explicit budget raise at dispatch. Stale baselines, lease loss and malformed receipts require explicit recovery. Both CLI entrances and the desktop execute eligible repaired attempts through their own hosts. Cross-checkout scheduling remains separate work.
