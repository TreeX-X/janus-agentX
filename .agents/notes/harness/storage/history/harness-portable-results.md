---
{
  "schema": "harness-note/2",
  "id": "554196e5-682a-4146-ae3a-3285be2d452d",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-18",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ceab8b86-319b-4ba8-9d22-4d43c9e1c12e",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-18-harness-portable-results.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "8f7296f001affcc7de9a00b19a6c60d78e8082aa77e904e55f4896506129eb1a",
      "historical": true
    }
  }
}
---

# Agent Note: Portable task results and current-branch closeout

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

A task result stored only in a local run disappears from another checkout. A receipt without a completed task reference can also satisfy coverage before the execution host finishes verification. Searching all Git refs for a contract string cannot prove that the selected branch contains the task, evidence and tested code together.

## Decision

Task execution metadata and immutable receipts under `.agents/evidence` are portable truth. The host writes execution, new receipt references and its local run snapshot under the existing note lock and journal. File hashes, run revisions and lease tokens reject stale writes. After-images precede target mutation; recovery classifies every target against its recorded before and after bytes and refuses foreign edits. Lease removal on terminal transitions shares that journal. Model tools retain their ledger-write prohibition; the host patches only execution metadata through YAML source ranges.

`readTaskResult` reconstructs execution and receipt validity without local runs. The offline command is `wfx-notes result <task-uri> --closeout`. CLI status, desktop adapters and dependency coverage use the same evidence validation. A task receipt contributes coverage only when its completed task references the matching mode, attempt and baseline. Current Git-visible scope additions invalidate old evidence. A foreign running task remains unverified and cannot be prepared over its existing execution.

Receipt identity hashes structurally ordered JSON, preserving array order and scalar values. JSON formatting and LF/CRLF do not change identity; code manifests retain raw byte hashes. Closeout searches HEAD-reachable candidate trees and checks the semantic task contract, completed execution, receipt content digest and every code manifest entry, including binary files and deletion. Explicit working-tree authorization produces no commit claim. Each explicit query checks current evidence and history instead of trusting a persisted success cache.

## Alternatives considered

- Reuse local run receipts: minimal storage work and complete local diagnostics, but copying the repository cannot reconstruct results and dependent tasks lose their evidence.
- Write each file independently: simpler IO, but a crash can publish done without its receipt or leave the local controller behind the shared task. The existing journal supplies bounded recovery without another transaction system.
- Hash raw receipt files: exact file identity is easy to inspect, but Git line-ending conversion changes JSON bytes without changing evidence. Structural identity is portable while tested code remains byte-exact.
- Reuse contract-string Git search: fast candidate discovery, but strings and other refs cannot establish the required tree contents. Candidate trees must be checked directly.

## Consequences

The portable-result integration suite passes 14 checks using real temporary Git repositories and real Node check processes with an injected structured reviewer. It covers fresh-clone reconstruction, requirement coverage, byte drift, binary and deleted files, branch reachability, absent receipts, task renaming, failure evidence, duplicate completion, journal interruption and foreign edits. `npm test --workspace=@janus-agent/harness-core` passes 70 checks, harness-node passes 29, notes-cli passes 7, and the janus-agent package passes 79. `npm test --workspace=@janus-agent/cli -- tests/harness-mode.test.ts` passes 15 checks. Workspace typecheck and build pass.

Read paths serialize short asset access and may scan Notes and code again; large repositories pay additional IO. Git closeout runs on explicit requests, without a persistent cache. Non-managed editors can still race filesystem scans. Tests inject process interruption; they do not establish power-loss durability for every filesystem. Active process recovery requires local coordination; portable results do not recreate conversations or authorize takeover. Old local-only records without matching formal assets require explicit re-verification and are not silently promoted. Real model, external runner, Ink and desktop execution acceptance remain separate work. The candidate standard is not activated by this implementation.
