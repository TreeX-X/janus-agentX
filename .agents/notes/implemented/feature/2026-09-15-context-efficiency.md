# Agent Note: Stable tools, pruning and usage accounting

Status: implemented

## Problem

Tool order changes shorten reusable request prefixes. Repeated old tool bodies increase input volume. Input/output totals alone do not distinguish reasoning and cached input; cutting fresh evidence can increase the number of model rounds needed to finish.

## Decision

The turn sorts manifests by providerName, freezes the active list and builds tools in that order. Local todo_write and ask_user tools follow workspace tools. The system prompt lists names and risks; descriptions live in tool schemas.

AgentUsage carries promptTokens and completionTokens with optional reasoningTokens and cachedInputTokens. Missing values mean unreported. CLI tracks turn and session totals and displays cached input when reported. Reasoning must not be added again to completion totals that already include it.

Pruning retains tool calls and replaces old bodies with digests. The default retained tail is 40,000 estimated tokens, configurable down to 4,000. Under actual window pressure, old bodies prune before conversation eviction or summarization. Fresh evidence, metadata deduplication, request budgeting and repair continuation follow [evidence integrity](../bug-fix/2026-09-16-agent-context-search-efficiency.md).

## Alternatives considered

Host registration order avoids sorting but exposes irrelevant host differences to provider caching. Stable ordering is inexpensive and does not change authorization.

Combining reasoning and cached usage into ordinary totals simplifies types but hides cost composition. Optional fields preserve compatibility and distinguish missing reporting from zero.

Do nothing / reuse: relying solely on provider overflow recovery avoids local budgeting but discovers capacity only after failure. Hard character truncation is short to implement but breaks exact-edit evidence and page cursors.

## Consequences

Tasks needing pruned source must re-read it. Token estimation does not replace provider tokenization, and sorted tools alone cannot guarantee cache hits.

Verification: npm run test --workspace=@janus-agent/chat-core covers sorting, pruning and fresh output integrity. npm run test --workspace=@janus-agent/cli includes actual SDK cache reporting in model-stream.test.ts and accumulation/reset in tui-store.test.ts.
