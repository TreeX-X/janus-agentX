---
{
  "schema": "harness-note/2",
  "id": "86c2d794-3be5-4807-b0fb-1f63c1baa910",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-08T10:14:57.813Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/a8df9255-0ba8-416f-8a68-429459957600"
}
---

# Engineering runtime

## Responsibility

Provide shared engineering sessions, tool policies, checkpointing and orchestration.

## Design

agent-core/chat-core keep file tools, script execution, streaming and session state available through shared ports. node-hosts supplies command/Git/MCP/Note capabilities. WorkflowX changes use these existing ports rather than a separate consumer-specific implementation.

Chat repair follows the latest tool batch's execution error flags. Successful domain results such as Note `validated`, `applied` or `unchanged` do not trigger repair or another model request. Denied/cancelled operations are not retried; a later successful batch consumes the earlier failure. Domain content cannot override the host execution result.

The JanusX README recording exposed the previous status-field heuristic: successful focus and write operations incorrectly requested repair. The orchestrator now tracks `tool_execution_end.isError` by call ID through the batch boundary. This preserves existing repair limits without maintaining a list of every tool's domain statuses.

Verification: `npm run test --workspace=@janus-agent/janus-agent -- tests/chat-turn.test.ts tests/chat-turn-maintenance.test.ts` passes 29 tests, including four domain-status regressions, actual failure repair, denied approvals and successful correction. `npm run build --workspace=@janus-agent/janus-agent` passes. These are Main checks, not independent review.
