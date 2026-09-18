# Agent Note: Task-scoped CLI execution and verification

Status: implemented

## Problem

A bound task needs executable scope and evidence. A prompt label alone permits ordinary chat tools to modify unrelated files, while a successful model response cannot establish acceptance coverage. Verification also needs a recoverable state when code changes, commands fail, the reviewer is unavailable, or execution is interrupted.

## Decision

The plain CLI sends bound input through `prepareTaskTurn` in `janus-agent`. The shared host checks the current run, lease token, contract and input digests before the turn and before each tool call. Only internal xdo execution is available. Delegated modes, foreign repositories, wildcard scopes and unsupported verification capabilities report `CAPABILITY_UNAVAILABLE`.

Task conversations persist separately under `.agents/.local/conversations`, keyed by run and attempt. Reattachment restores task history without inserting ordinary chat history. Harness turns use attached runtime resources but skip personal memory recall and capture. File mutations use the existing runtime tools and approvals. Literal file and directory scope, path traversal, links, hard-linked targets, ignored files and ledger paths have host checks. The model has no command, process or delegation capability. Reads can inspect the checkout beyond the mutation scope.

`/harness verify` pins a Git-visible file manifest, runs the exact declared commands through the existing command runtime, and invokes a fresh read-only self-review conversation. Command completion requires a completed runtime result, `ok`, exit code zero and no timeout. The reviewer supplies structured coverage and a review bound to the manifest digest and implementor identity. Core receipt validation checks every declared check and acceptance reference. Model prose, malformed JSON, incomplete coverage and failing checks cannot complete a run. File additions, deletions or changed bytes detected before finish produce a blocked receipt so dependency checks cannot reuse stale approval. Receipts remain immutable, and closeout checks run separately through `/harness closeout`.

`/harness pause|resume|repair|rebaseline|start|cancel` expose explicit recovery. Aborted task turns and verification pause the run. Rebaseline returns a run to queued, clears verification, and releases the old lease so a new start can claim it. A task with no related inputs can rebaseline because its own contract is already pinned. Manual repair requires a reason and a stored failure receipt; another attempt receives both in its task context without claiming an automatic repair.

`harness-node` owns task snapshots and scope manifests. JanusX reuses the same live-snapshot implementation and can supply command and review ports to the shared executor. The desktop panel and Ink loop do not invoke this execution path yet.

## Alternatives considered

- Reuse ordinary chat with a task prompt: existing history and tools need little adaptation, but prompts cannot enforce file scope or isolate task evidence. The shared host owns these checks.
- Expose arbitrary commands and check their working directory: this preserves broad coding capabilities, but a process can write beyond its working directory. Only commands explicitly declared in the accepted contract reach the verification runner; runtime approval still applies.
- Infer coverage from successful commands: this needs no reviewer, but exit status does not establish which criteria a check demonstrates. A structured self-review supplies that mapping and the receipt validator checks its completeness.
- Build a new command runner: a separate runner can carry an execution-specific interface, but it duplicates Windows process handling, timeouts, approvals and logs. The CLI adapts the existing runtime through a separately cancellable command session.

## Consequences

`npm test --workspace=@janus-agent/janus-agent -- tests/task-execution.test.ts tests/chat-turn.test.ts` passes 33 checks. `npm test --workspace=@janus-agent/cli -- tests/harness-mode.test.ts` passes 15 checks. They cover scoped tool denial, lease and baseline drift, process failures, immutable evidence, repair, cancellation, isolated history, real command execution and the plain REPL route. The core receipt suite passes 11 checks, including canonical review digests. Workspace typecheck and build pass.

This host executes one checkout and literal file scopes. `.agents` mutations, ignored output, directory deletion, manual verification and delegated review need separate capabilities. Manifest collection hashes every Git-visible scoped file, including unchanged files; broad scopes cost additional IO. Declared verification commands are trusted workspace code under runtime policy, not an operating-system sandbox. The evidence model does not prove absence of effects outside the checkout or in ignored files. External edits can race filesystem scans.

[Portable results](2026-09-18-harness-portable-results.md) persist execution in task Notes and receipts in formal evidence, with shared reconstruction and current-branch closeout. Automatic repair scheduling, external runner launch, desktop execution and detailed evidence UX, Ink integration and shared maintenance conversation control remain incomplete. These limits keep S8 and the standard cutover open. Candidate standards and old assets retain their current lifecycle.
