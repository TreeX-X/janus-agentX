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
digests, with `depends-on` followed transitively and cycles refused with
the chain. Requirement predecessors prove every acceptance criterion
against evidence and run receipts: matching criterion hash, cited checks
passed with all required checks passed, and code manifests rehashed
against the worktree. Task predecessors need a done state with
discoverable receipt files, pinned as contract-plus-receipt hashes.
Unresolvable, invalid, uncovered, undone, or receipt-less predecessors
refuse with named diagnostics; first visit wins per target in
deterministic relation order (disagreeing criteria subsets on one target
stay unmerged as documented below). Two small kernel changes support
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
  `packages/harness-node/tests/baseline.test.ts` (8 checks: deterministic
  three-input pin with URI resolution, non-task/draft/unknown/unresolved
  refusals, uncovered-criteria naming, undone and receipt-less
  predecessors, cycle chain, prose-move digest drift, per-criterion
  coverage proof), package suite green (24 checks), `npm run typecheck`
  and `npm run build` pass.
- **Costs and limits**: cross-repo targets stay unresolved until the
  workspaces bind more than one checkout. Two edges covering different
  criteria subsets of one target pin the first subset; disagreeing
  subsets on one target are pathological and stay unmerged. Draft
  predecessors pin by digest and stale on acceptance, by design rather
  than by refusal. Revisit when multi-checkout binding or the receipt
  registry centralizes evidence.
