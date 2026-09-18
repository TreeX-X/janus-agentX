# Agent Note: Shared task baseline collection

Status: implemented

## Problem

Dispatching a run needs a fixed C3 baseline — the task contract hash
plus content digests of related notes — but no shared code assembled it.
Each future runner (CLI now, desktop later) would reimplement relation
walking, coverage proof, and predecessor checks, and the first
disagreement on what counts as "covered" or "done" would fork baselines
across hosts. File-hash snapshots are no substitute: toggling an
acceptance checkbox would stale a run that only tracked progress.

## Decision

`packages/harness-node/src/baseline.ts` collects the baseline from a
live checkout. The task note must be an accepted, valid task; its
contract hash comes from the shared hasher. Direct `implements`,
`governed-by`, and `depends-on` targets pin through per-kind normative
digests, with dependency and governance edges followed transitively and cycles refused.
Implementation goals need no prior completion evidence. Requirement predecessors prove every acceptance criterion
against formal evidence receipts: matching criterion hash, cited checks
passed with all required checks passed, and code manifests rehashed
against the worktree. Task predecessors need a done state with
current valid receipt files, pinned as contract-plus-receipt hashes.
Unresolvable, invalid, uncovered, undone, or receipt-less predecessors
refuse with named diagnostics; repeated target visits merge criterion subsets.
The [receipt validity decision](../bug-fix/2026-09-18-harness-receipt-gates.md) defines the proof checks.
Two small kernel changes support
this collector: dispatch accepts empty inputs because a standalone task
pins through its contract hash alone, and the run store gains record
listing with load and lease readers so shells reattach without new
plumbing. Checkbox flips never move a digest because
criterion lines normalize before hashing.

## Alternatives considered

- Snapshot file hashes as input pins — strongest case is ten lines of
  code, but every checkbox flip and comment edit stales a healthy run;
  content digests pin meaning, not bytes.
- Trust predecessor states from note prose — strongest case is no
  evidence scanning, but an unchecked claim of "done" becomes a fixed
  baseline; receipts and live rehashes make coverage a proof.
- Let each runner assemble baselines — strongest case is no new shared
  module, but two assemblers disagree on edge cases within a release;
  one collector keeps every host on the same pin.
- Inline collection into the CLI controller — strongest case is fewer
  files, but the desktop launch entry needs the identical baseline next;
  shared code lives in the shared package.
- Do nothing / reuse — hand-write baselines per run; rejected because
  hand-pinned hashes cannot be audited and silently under-pin relations.

## Consequences

- **Gains**: every host pins the same baseline for the same task
  revision. Verification:
  `packages/harness-node/tests/baseline.test.ts` covers deterministic pins,
  repository identity, adopted inputs, acceptance references, unmet goals,
  prerequisite evidence, cycles, and drift. `npm run typecheck`
  and `npm run build` pass.
- **Costs and limits**: cross-repo targets stay unresolved until the
  workspaces bind more than one checkout. Evidence validation rescans notes
  while traversing dependencies. Revisit when multi-checkout binding or the receipt
  registry centralizes evidence.
