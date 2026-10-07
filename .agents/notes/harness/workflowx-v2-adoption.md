---
{
  "schema": "harness-note/2",
  "id": "0b2e7c13-8ae0-42d9-b185-1dd575c43a19",
  "kind": "decision",
  "lifecycle": "implemented",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:25:42.742Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/427edb4f-5f85-4c99-aa29-3ef947bc80d3"
}
---

# Adopt WorkflowX maintained module documents

## Problem

The previous runtime only understood harness-note/1, generated date-prefixed files and selected review by execution mode. Copying the new skills alone would leave writers, wiki readers and Task execution inconsistent with WorkflowX.

## Decision

Reuse the shared harness-core, harness-node and janus-agent boundaries. The WorkflowX 82d5b3d reference algorithm and v2 schema are packaged with harness-core; storage stays in harness-node. The public Task input/hash and baseline digest follow v2, while legacy v1 and sealed receipt hashing remain unchanged. Both known profiles are supported; an old profile cannot write v2 sources.

New projects start with module.md. Notes have six kinds, explicit module ownership, stable filenames and refreshed maintenance times. The structured writer supports in-place maintenance, type conversion, moves and authorized deletion, validates the final module/reference structure, and journals both sides of moves. Original creation time and exact read hashes are preserved. Conflicting or missing references must be repaired in the same transaction.

Wiki snapshots expose module/parent, kind, moduleState, updated and raw source identity through one common source reader. Note tools support module/type filters and report result limits. Profile changes invalidate cached discovery; changed files use the existing incremental index with module validation. Planned modules and parent-level documents coexist.

Ordinary xdo does not create Task and does not demand a Note write when facts are unchanged. Task-bound runs retain work.review across modes and require matching independent receipt identity. Before each implementation/review handoff, Main Agent's runtime updates bounded checkpoint blocks in the shared Task, preserving authored progress, evidence and handoff context. Worker tools cannot mutate execution ledgers; fixed baselines, leases and transaction recovery remain authoritative.

## Alternatives considered

Replacing the runtime with another scanner would duplicate source truth for CLI and JanusX. Copying skills without runtime changes would leave incompatible writers active. Reimplementing v2 canonicalization independently would repeat the divergence found in WorkflowX review; packaging its pure algorithm and checking locked fixtures keeps the boundary testable.

## Consequences

Sixty tracked old Notes were migrated before final corpus validation; identities and original source hashes are recorded in the [inventory](../../../docs/migrations/note-v2.json). Legacy records are explicitly historical, not new v2 execution evidence. One pre-existing untracked main-checkout Note is protected by an exact-hash exclusion. Merged a801a806420b31faa9fe7281a4b3f799497f693f into main by fast-forward. Pre-existing main deletions are preserved in stash f8a48c8e58490f9a865a2cc059d366aaf89620c8; untracked Notes/plans were restored without replaying deletions over the integrated source. Checkout-local runtime state and rule backups are ignored by Git.

Workspace build passes. The final relevant suites pass 319 tests: harness-core 92, harness-node 55, janus-agent 100, node-hosts 59 and notes-cli 13. The broader run also passed agent-core 359 with one existing skip, chat-core 64 and 400 CLI tests; one CLI automatic-repair test exceeded its 5-second limit under concurrency. The entire 20-test harness-mode suite passed on isolated rerun. These tests use controlled model/reviewer ports; no live model or JanusX UI acceptance is claimed.

AgentX and WorkflowX corpus checks and local managed-rule parity pass. JanusX integration, visual type grouping, README demonstrations and final release/push remain later work. The runtime changes are ready for that integration, not a claim of final cross-product release acceptance.

After merge, the main checkout passed workspace build, 13 targeted v2/profile/handoff tests, agentX corpus verification, WorkflowX corpus verification and managed-rule parity. Known legacy teammate bodies were merged explicitly while preserving their frontmatter; originals remain in .agents/.local/pre-v2-rules. No remote push was performed.
