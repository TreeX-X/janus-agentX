---
{
  "schema": "harness-note/2",
  "id": "21c6a27f-d3e2-4986-9875-4cdf22253bf7",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-15",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/86c2d794-3be5-4807-b0fb-1f63c1baa910",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/feature/2026-09-15-context-efficiency.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "48e99e95c0bd2d2a5f646e60c66b24d5addef7477c79e8cd89f964dd310c92aa",
      "historical": true
    }
  }
}
---

# Agent Note: Stable tools, pruning and usage accounting

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

Tool order changes shorten reusable request prefixes. Repeated old tool bodies increase input volume. Input/output totals alone do not distinguish reasoning and cached input; cutting fresh evidence can increase the number of model rounds needed to finish.

## Decision

The turn sorts manifests by providerName, freezes the active list and builds tools in that order. Local todo_write and ask_user tools follow workspace tools. The system prompt lists names and risks; descriptions live in tool schemas.

AgentUsage carries promptTokens and completionTokens with optional reasoningTokens and cachedInputTokens. Missing values mean unreported. CLI tracks turn and session totals and displays cached input when reported. Reasoning must not be added again to completion totals that already include it.

Pruning retains tool calls and replaces old bodies with digests. The default retained tail is 40,000 estimated tokens, configurable down to 4,000. Under actual window pressure, old bodies prune before conversation eviction or summarization. Fresh evidence, metadata deduplication, request budgeting and repair continuation follow [evidence integrity](agent-context-search-efficiency.md).

## Alternatives considered

Host registration order avoids sorting but exposes irrelevant host differences to provider caching. Stable ordering is inexpensive and does not change authorization.

Combining reasoning and cached usage into ordinary totals simplifies types but hides cost composition. Optional fields preserve compatibility and distinguish missing reporting from zero.

Do nothing / reuse: relying solely on provider overflow recovery avoids local budgeting but discovers capacity only after failure. Hard character truncation is short to implement but breaks exact-edit evidence and page cursors.

## Consequences

Tasks needing pruned source must re-read it. Token estimation does not replace provider tokenization, and sorted tools alone cannot guarantee cache hits.

Verification: npm run test --workspace=@janus-agent/chat-core covers sorting, pruning and fresh output integrity. npm run test --workspace=@janus-agent/cli includes actual SDK cache reporting in model-stream.test.ts and accumulation/reset in tui-store.test.ts.
