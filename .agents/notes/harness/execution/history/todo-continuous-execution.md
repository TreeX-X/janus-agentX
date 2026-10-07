---
{
  "schema": "harness-note/2",
  "id": "f14e0b47-fd2f-413c-8f7f-874e3ca39d32",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-15",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ea2ff74a-384a-432f-8938-89ba3dcf6f09",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/feature/2026-09-15-todo-continuous-execution.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "b56c07670f02db67b94eb57ba7615d24c257d9515c9ad453206a5f8ad2589953",
      "historical": true
    }
  }
}
---

# Agent Note: Todo continuation with progress gating

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

A model can stop with pending work after a text-only answer. Unconditional continuation also spends repeated requests when no progress is possible. Cancelled tasks must not inflate the open count.

## Decision

The turn injects one todo reminder per progress state. The state includes the current list and the number of successful workspace tool results. New progress permits another reminder; a second text-only answer with unchanged state returns control to the user. Failure handling and duplicate-call bounds follow [context efficiency](../../../agent/history/agent-context-search-efficiency.md).

The model replaces the complete list when adding, splitting, or cancelling tasks. Validation permits 1-20 items and at most one in_progress item. Both summarizeTodos and hasOpenTodos count only pending and in_progress; completed and cancelled are closed.

## Alternatives considered

One reminder for the entire turn is simple, but cannot drive the next task after new progress. A reminder on every text-only answer enforces continuation but consumes the entire turn limit during a blocker. Progress gating bounds text loops without guessing blocker meaning from language-specific keywords.

Do nothing / reuse: prompt-only continuation needs no state, but leaves pending tasks idle. A background wake-up service requires another scheduler when the in-turn hook already covers the need.

## Consequences

A concrete blocker can receive one reminder. Successful but unhelpful tool calls still count as progress; maxTurns remains the final bound. The model owns the truth of task completion.

Verification: npm run test --workspace=@janus-agent/janus-agent covers unchanged-state reminders, closed/cancelled lists and closing through a tool. npm run test --workspace=@janus-agent/chat-core covers cancelled-item counts.
