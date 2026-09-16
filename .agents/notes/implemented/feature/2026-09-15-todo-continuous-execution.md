# Agent Note: Todo continuation with progress gating

Status: implemented

## Problem

A model can stop with pending work after a text-only answer. Unconditional continuation also spends repeated requests when no progress is possible. Cancelled tasks must not inflate the open count.

## Decision

The turn injects one todo reminder per progress state. The state includes the current list and the number of successful workspace tool results. New progress permits another reminder; a second text-only answer with unchanged state returns control to the user. Failure handling and duplicate-call bounds follow [context efficiency](../bug-fix/2026-09-16-agent-context-search-efficiency.md).

The model replaces the complete list when adding, splitting, or cancelling tasks. Validation permits 1-20 items and at most one in_progress item. Both summarizeTodos and hasOpenTodos count only pending and in_progress; completed and cancelled are closed.

## Alternatives considered

One reminder for the entire turn is simple, but cannot drive the next task after new progress. A reminder on every text-only answer enforces continuation but consumes the entire turn limit during a blocker. Progress gating bounds text loops without guessing blocker meaning from language-specific keywords.

Do nothing / reuse: prompt-only continuation needs no state, but leaves pending tasks idle. A background wake-up service requires another scheduler when the in-turn hook already covers the need.

## Consequences

A concrete blocker can receive one reminder. Successful but unhelpful tool calls still count as progress; maxTurns remains the final bound. The model owns the truth of task completion.

Verification: npm run test --workspace=@janus-agent/janus-agent covers unchanged-state reminders, closed/cancelled lists and closing through a tool. npm run test --workspace=@janus-agent/chat-core covers cancelled-item counts.
