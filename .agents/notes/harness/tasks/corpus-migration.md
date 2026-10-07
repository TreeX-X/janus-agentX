---
{
  "schema": "harness-note/2",
  "id": "be017850-3a3d-4248-970e-b7cbd3c1a31f",
  "kind": "task",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/427edb4f-5f85-4c99-aa29-3ef947bc80d3",
  "work": {
    "scope": [
      {
        "repoId": "62b44166-82f0-41ff-838d-e2b02388ed06",
        "paths": [
          ".agents/notes/",
          "packages/",
          "docs/migrations/"
        ]
      }
    ],
    "acceptanceRefs": [
      {
        "uri": "note://62b44166-82f0-41ff-838d-e2b02388ed06/be017850-3a3d-4248-970e-b7cbd3c1a31f",
        "criterionId": "AC-1"
      }
    ],
    "verification": [
      {
        "id": "V-1",
        "kind": "command",
        "required": true,
        "repoId": "62b44166-82f0-41ff-838d-e2b02388ed06",
        "cwd": ".",
        "program": "node",
        "args": [
          "scripts/verify-note-corpus.mjs"
        ]
      }
    ],
    "review": "self"
  }
}
---

# Migrate agentX legacy Notes

## Scope

Separate corpus migration before final parser validation. Preserve identities, historical evidence and unrelated main-checkout assets.

## Acceptance criteria

- [x] AC-1: All 60 tracked sources have recorded hashes, stable module-owned targets and repaired reverse references; final corpus verification passes.

## Verification

Run V-1 after the migration and runtime build.

## Progress

60 sources rewritten into module folders. Both agentX and WorkflowX corpus checks pass after reference repair.

## Evidence

[Inventory](../../../../docs/migrations/note-v2.json) records exact original revision and source hashes. No historical receipts are rewritten.

## Handoff

Corpus validation is complete. Main Agent completes branch integration; JanusX adopts the shared boundary next. Keep this Task current before handoff.
