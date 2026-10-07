---
{
  "schema": "harness-note/2",
  "id": "427edb4f-5f85-4c99-aa29-3ef947bc80d3",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-07T17:21:40.917Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/a8df9255-0ba8-416f-8a68-429459957600"
}
---

# WorkflowX harness

## Responsibility

Maintain original module documents and their portable execution evidence.

## Design

Support harness-note/2 module, note, idea, requirement, decision and task. Preserve legacy readers and sealed receipt semantics. Ordinary xdo maintains relevant documents without creating Task. Main Agent owns shared Task handoffs.

[Runtime adoption](workflowx-v2-adoption.md) records the implementation, validation and integration limits. [Corpus migration](tasks/corpus-migration.md) owns the separate legacy migration work item.
