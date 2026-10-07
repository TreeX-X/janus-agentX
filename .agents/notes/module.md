---
{
  "schema": "harness-note/2",
  "id": "a8df9255-0ba8-416f-8a68-429459957600",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "role": "project"
}
---

# agentX

## Responsibility

Own shared engineering tools, sessions and WorkflowX harness capabilities. CLI and JanusX consume these packages.

## Design

harness-core owns format/hash contracts; harness-node owns source reads, wiki indexing and recoverable writes; janus-agent coordinates task execution. agent-core/chat-core provide engineering sessions and node-hosts exposes commands, Git, MCP and Note tools. JanusX visual adoption is a later phase.
