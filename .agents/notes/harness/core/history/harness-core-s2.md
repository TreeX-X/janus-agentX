---
{
  "schema": "harness-note/2",
  "id": "c9e101a9-90d9-4a96-bf7a-f5db64f2344a",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-16",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/a7d6f2a2-bebc-4418-ae1e-600b310e3fa6",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-16-harness-core-s2.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "87b579ec5de74222ac299d865c4578c8ebc6edadf2e42df893b921326366ed70",
      "historical": true
    }
  }
}
---

# Agent Note: Harness core shared data logic

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem
Three hosts define note shapes, hashes, and acceptance checks on their own. Each local definition drifts, so later file storage, desktop editing, and execution hosts cannot share one verdict.

## Decision
The shared logic lives in the [harness-core package](../../../../../packages/harness-core/src/index.ts) as ten focused modules: vocabulary, frontmatter plus body parsing, deterministic serialization, graph rules, contract hashing, lifecycle table, execution machine, receipt validity, change-set validity, and one entry barrel. Frontmatter parsing uses the `yaml` Document model with duplicate-key, custom-tag, and anchor rejection; body structure uses Markdown AST with GFM checklists, so fenced code never counts as headings or boxes. The contract hash ports the S1 sample verbatim and reproduces its locked digest. The package touches no files, no Electron shell, no run loop, and no model calls; storage and execution adapters arrive in later segments.

## Alternatives considered
- Hand-rolled YAML subset carried over from the S1 checker — strongest case is zero new dependencies, but block scalars, timestamps, and comment edge cases each need bespoke handling, and the shared library serves all hosts for years.
- Schema declarations through the validation library used by the run core — strongest case is house consistency, but precise machine codes per field read clearer as direct checks, and fewer dependencies keep the future light CLI closure small.
- Do nothing / reuse — keep the S1 checker script as the only gate; rejected because a script tied to one checkout cannot serve desktop storage or execution hosts as an import.

## Consequences
- **Gains**: `npm run typecheck`, `npm run build`, and `vitest run` pass in the new workspace with 59 checks across 8 files, including unchanged S1 fixtures, the locked digest, loop detection, state tables, and receipt drift rules.
- **Costs and limits**: byte-preserving partial edits stay with the file repository segment; this package regenerates frontmatter deterministically instead. All-digit zero digests coerce from YAML numbers back to source strings. Revisit when storage or execution hosts demand new error codes.
