# Agent Note: Managed note storage and offline CLI

Status: implemented

## Problem
Terminal editors, desktop views, and later execution hosts write the same note files through separate code paths. Each path invents locking, recovery, and diagnostics on its own, so concurrent saves lose bytes and crashed writes leave half-applied graphs.

## Decision
One file adapter owns all managed writes from [harness-node](../../../../packages/harness-node/src/index.ts): note scan with symlink confinement, checkout resolve that asks instead of guessing, short-lived lock files with dead-owner reclaim, journal-first multi-file apply with idempotent operation records, external-change facts through a watcher, and git worktree plus landing-commit primitives for closeout. The [offline CLI](../../../../packages/notes-cli/src/cli.ts) exposes list, show, create, check, and apply over the same functions with fixed JSON envelopes and exit codes, and its runtime closure holds only parsing libraries. Deletes stay behind an explicit grant; unknown references stay unresolved; foreign bytes mid-transaction park recovery instead of merging.

## Alternatives considered
- Each host keeps its own file code behind a shared checklist — strongest case is zero new packages, but checklists drift and the first real conflict writes two winners.
- Full database or service as the store — strongest case is stronger concurrency, but offline terminals and plain git checkouts become second-class writers, against the file-first goal.
- Do nothing / reuse — keep ad-hoc writes; rejected because half-applied graphs already block unified acceptance.

## Consequences
- **Gains**: typecheck, build, and 23 checks pass across both workspaces; the built binary checks six S1 fixtures clean with exit zero, and crash-injection plus conflict suites lock the F03/F04 behavior.
- **Costs and limits**: cross-checkout merges, indexed search, and the janus command adapter wait for later segments; full-text search stays a substring scan. Revisit when desktop editing or execution hosts need them.
