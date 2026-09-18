# Agent Note: Harness execution eligibility and receipt validity

Status: implemented

## Problem

A receipt with missing live hashes, omitted acceptance coverage, or a downgraded required check can certify incomplete work when validation inspects only the fields that the receipt supplies. A failed independent review must remain usable as repair evidence, yet it cannot prove completion. Overwriting its id destroys that evidence. Task preparation also needs to distinguish the requirement being implemented from an already completed prerequisite; requiring both to have passing receipts prevents new work from starting.

## Decision

`harness-core` validates nested receipt data before consuming it. Completion compares inputs against the complete live input set, coverage against the task's acceptance references, and checks against the task's declared verification steps, including command arguments and working directory. Missing current hashes fail validity. A present null file hash proves deletion; an absent map entry means the file was not checked. Failed or blocked independent reviews remain valid receipt records and fail completion. Duplicate ids, ambiguous file rows, unknown results, and unresolved check references return diagnostics.

The run dispatcher accepts receipts only during verification and requires the run's task, mode, attempt, contract, and input set. Finish compares the receipt file manifest with the manifest pinned at verify. Receipt storage creates an id once; an identical retry succeeds and a changed body returns CONFLICT without overwriting bytes. Closeout requires a successfully finished run and uses its recorded completion receipt before examining Git or working-tree evidence; the most recently stored failure cannot substitute for that receipt. Older local run snapshots without this completion reference require renewed verification and cannot infer a passing receipt by list position.

The shared baseline collector pins implementation goals without requiring those goals to be complete. Explicit dependencies still require current evidence. A done predecessor needs a receipt whose current contract, inputs, criteria, checks, review and code pass the same validator. Taskless xdo evidence must pin the content of the criteria it covers. Foreign repository URIs cannot resolve through a colliding local id, and foreign file manifests remain unresolved. Acceptance references resolve before dispatch and match implements criteria. Adopted decisions governing requirements also enter the baseline; repeated visits merge criterion subsets.

The review digest is SHA-256 over UTF-8 JSON of tuples `[repoId, path, sha256-or-null, deleted-boolean]`, ordered lexically by repository id and path without locale-dependent comparison. Sorting makes row order irrelevant; file identity, content and deletion remain significant. `codeManifestHash` supplies this algorithm to all hosts. Completion rejects a well-formed hash that does not cover the receipt manifest. Receipts using placeholder digests need renewed review evidence.

## Alternatives considered

- Enforce completion only in each host's UI: this gives each surface direct feedback, but terminal and desktop callers can bypass different checks. The shared validator owns the decision and hosts supply the current task contract.
- Discard failed reviews: this reduces stored evidence, but repair needs the failure receipt and its identity. Failed evidence is retained with a failed completion verdict.
- Do nothing / reuse the existing partial checks: this avoids changing test fixtures, but missing proof can become success and an implementation goal cannot start without pre-existing evidence.

## Consequences

`npm run test --workspace=@janus-agent/harness-core --workspace=@janus-agent/harness-node --workspace=@janus-agent/janus-agent` verifies the shared packages with 66, 29, and 65 checks. The CLI harness-mode and notes suites pass 20 checks with current predecessor receipts; the related session, REPL, command and executor suites bring the focused CLI run to 58 checks. Workspace `npm run typecheck` and `npm run build` pass. The desktop adapter supplies the same acceptance and verification context and passes its seven adapter checks plus 15 neighboring harness checks.

Evidence validation rescans the checkout and can cost repeated scans in larger dependency graphs. Cross-checkout verification remains unavailable until a host supplies the other roots. Git closeout still has its existing commit-search limits. The [task execution host](../architecture/2026-09-18-harness-task-execution.md) supplies scoped xdo turns and receipts; shared maintenance conversation control and the complete desktop evidence flow remain separate integration work.
