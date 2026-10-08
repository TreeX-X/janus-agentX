---
{
  "schema": "harness-note/2",
  "id": "ea2ff74a-384a-432f-8938-89ba3dcf6f09",
  "kind": "module",
  "lifecycle": "accepted",
  "created": "2026-10-07",
  "updated": "2026-10-08T02:03:08.530Z",
  "moduleState": "implemented",
  "parent": "note://62b44166-82f0-41ff-838d-e2b02388ed06/427edb4f-5f85-4c99-aa29-3ef947bc80d3"
}
---

# Task execution and handoff

## Responsibility

Run accepted scoped Tasks and preserve their fixed execution grounds.

## Design

Main Agent owns all Task writes; children read fixed contracts. Task execution returns the implementer's Change Summary and Note draft as implementationResult alongside verification evidence for Main Agent integration. xdel stops after self-review with any required independent review pending. xdo on an explicit Task and xflow retain required independent evaluation.

One runtime-owned Handoff block identifies the next action. Main Agent-authored progress and evidence remain intact without duplicate execution fields. Runtime tools preserve leases, baseline checks and formal receipt validation; model prose is not proof of completion.
