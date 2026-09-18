# Agent Note: Harness execution eligibility and receipt validity

Status: implemented

## Problem

A receipt with missing live hashes, omitted acceptance coverage, or a downgraded required check can certify incomplete work when validation inspects only the fields that the receipt supplies. A failed independent review must remain usable as repair evidence, yet it cannot prove completion. Overwriting its id destroys that evidence. Task preparation also needs to distinguish the requirement being implemented from an already completed prerequisite; requiring both to have passing receipts prevents new work from starting.

## Decision

`harness-core` validates nested receipt data before consuming it. Completion compares inputs against the complete live input set, coverage against the task's acceptance references, and checks against the task's declared verification steps, including command arguments and working directory. Missing current hashes fail validity. A present null file hash proves deletion; an absent map entry means the file was not checked. Failed or blocked independent reviews remain valid receipt records and fail completion. Duplicate ids, ambiguous file rows, unknown results, and unresolved check references return diagnostics.

The run dispatcher accepts receipts only during verification and requires the run's task, mode, attempt, contract, and input set. Finish compares the receipt file manifest with the manifest pinned at verify. Receipt storage creates an id once; an identical retry succeeds and a changed body returns CONFLICT without overwriting bytes. Closeout requires a successfully finished run and uses its recorded completion receipt before examining Git or working-tree evidence; the most recently stored failure cannot substitute for that receipt. Older local run snapshots without this completion reference require renewed verification and cannot infer a passing receipt by list position.

The shared baseline collector pins implementation goals without requiring those goals to be complete. Explicit dependencies still require current evidence. A done predecessor needs a receipt whose current contract, inputs, criteria, checks, review and code pass the same validator. Taskless xdo evidence must pin the content of the criteria it covers. Foreign repository URIs cannot resolve through a colliding local id, and foreign file manifests remain unresolved. Acceptance references resolve before dispatch and match implements criteria. Adopted decisions governing requirements also enter the baseline; repeated visits merge criterion subsets.

## Alternatives considered

- Enforce completion only in each host's UI: this gives each surface direct feedback, but terminal and desktop callers can bypass different checks. The shared validator owns the decision and hosts supply the current task contract.
- Discard failed reviews: this reduces stored evidence, but repair needs the failure receipt and its identity. Failed evidence is retained with a failed completion verdict.
- Do nothing / reuse the existing partial checks: this avoids changing test fixtures, but missing proof can become success and an implementation goal cannot start without pre-existing evidence.

## Consequences

`npm run test --workspace=@janus-agent/harness-core --workspace=@janus-agent/harness-node --workspace=@janus-agent/janus-agent` verifies the shared packages (65, 29, and 50 checks; changed packages are rerun after their final edits). `npm run test --workspace=@janus-agent/cli -- tests/harness-mode.test.ts tests/notes.test.ts` passes 12 checks with genuine predecessor receipts. Workspace `npm run typecheck` and `npm run build` pass; the final harness-node and janus-agent builds also pass. The desktop adapter supplies the same acceptance and verification context and passes its seven adapter checks plus 21 neighboring harness checks.

Evidence validation rescans the checkout and can cost repeated scans in larger dependency graphs. Cross-checkout verification remains unavailable until a host supplies the other roots. The review manifest hash has shape validation; a common digest algorithm and its semantic comparison remain a separate standard clarification. Git closeout still has its existing commit-search limits. The model runner, automatic receipts, and shared chat controller remain separate integration work; these gates do not claim those capabilities.
