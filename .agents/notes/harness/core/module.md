---
{
  "schema": "harness-note/2",
  "id": "a7d6f2a2-bebc-4418-ae1e-600b310e3fa6",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/427edb4f-5f85-4c99-aa29-3ef947bc80d3"
}
---

# Format and contract identity

## Responsibility

Parse, validate and serialize original Notes without filesystem access.

## Design

The vendored WorkflowX 82d5b3d pure reference supplies v2 validation and hashing. Legacy v1 hashes are unchanged. Raw-byte identity, contract identity and fixed-input digest have distinct purposes. Canonical details stay in common code rather than model prompts.
