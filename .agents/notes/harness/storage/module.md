---
{
  "schema": "harness-note/2",
  "id": "ceab8b86-319b-4ba8-9d22-4d43c9e1c12e",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/427edb4f-5f85-4c99-aa29-3ef947bc80d3"
}
---

# Module storage and wiki

## Responsibility

Own selected-checkout source discovery, module navigation and transactional maintenance.

## Design

Each module has module.md and can hold topic Notes beside submodules. Expose ownership, type, state, maintenance time and exact source hashes. Create stable subject files, update topics in place, and validate post-move module ownership and live references. Journals recover both sides of a move; stale reads cannot overwrite newer sources.
