---
{
  "schema": "harness-note/2",
  "id": "86c2d794-3be5-4807-b0fb-1f63c1baa910",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/a8df9255-0ba8-416f-8a68-429459957600"
}
---

# Engineering runtime

## Responsibility

Provide shared engineering sessions, tool policies, checkpointing and orchestration.

## Design

agent-core/chat-core keep file tools, script execution, streaming and session state available through shared ports. node-hosts supplies command/Git/MCP/Note capabilities. WorkflowX changes use these existing ports rather than a separate consumer-specific implementation.
