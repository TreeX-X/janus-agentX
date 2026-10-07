---
{
  "schema": "harness-note/2",
  "id": "91a6a0f8-4186-4b6a-9d64-eedfec165e3a",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/a8df9255-0ba8-416f-8a68-429459957600"
}
---

# CLI host

## Responsibility

Expose shared engineering tools and WorkflowX capabilities in the terminal.

## Design

CLI and notes-cli reuse harness-node for original Note reads and mutations. Their presentation and terminal interactions remain host-owned. A module entry is navigation context, not a Task or runtime dependency.
