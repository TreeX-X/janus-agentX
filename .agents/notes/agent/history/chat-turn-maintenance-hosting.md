---
{
  "schema": "harness-note/2",
  "id": "8ed75baa-4671-48ef-bc3d-ac907558d49c",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-17",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/86c2d794-3be5-4807-b0fb-1f63c1baa910",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-17-chat-turn-maintenance-hosting.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "ff219d58c6653f5638fd76ba2c5e2304142e25338faafab2d737510090536654",
      "historical": true
    }
  }
}
---

# Agent Note: Chat turn hosts read-only maintenance discussions

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

`runChatTurn` only hosts two shapes: full janus-chat turns with workspace
mutation, recall, and capture, or tool-less turns with no workspace access
at all. A maintenance discussion needs the middle shape: attached
workspaces resolve for reads, personal recall and capture never run, the
caller pins domain rules, and the offering carries read-only tools without
the local todo/ask tools the maintenance panel has no UI for. Without that
shape, JanusX maintenance keeps its own agent loop, and every turn-lock,
steering, retry, and recovery fix ships twice.

## Decision

`ChatTurnRequest` carries `systemPromptPrefix` and `toolAllowlist`.
The prefix prepends the caller identity before the built system prompt;
the allowlist intersects the staged offering across workspace, todo, and
ask tools, matching names loosely across dotted and underscored spellings.
The `maintenance` sourceTag resolves attached workspaces exactly like
janus-chat while recall and capture stay janus-chat-only, so project turns
read the same files without touching personal memory. The mutation
recovery follow-up additionally requires an offered mutation tool, so a
read-only turn never urges an attempt it cannot perform.

## Alternatives considered

- Route maintenance through sourceTag `janus-chat` with a filtered host
  registry — strongest case is zero shared-code change, but the tag then
  lies about the domain and any future tag-gated behavior silently changes
  maintenance semantics; an explicit tag keeps the contract checkable.
- Inject caller-owned model and loop tools instead of an allowlist —
  strongest case is interactive blueprint reads mid-turn, but custom tool
  execution plumbing doubles the ports surface for one caller; maintenance
  pre-reads its scope snapshot like the proposal path already does.
- Offer todo/ask to maintenance and let the deny path absorb it —
  strongest case is a uniform offering, but the model spends a round
  discovering a tool that always fails; the allowlist drops them before
  the first model call.
- Do nothing / reuse — keep the JanusX-side discussion loop; rejected
  because turn, steering, retry, and recovery behavior then drift across
  two runners with no shared verdict.

## Consequences

- **Gains**: one turn runner serves chat and maintenance discussions with
  the same lock, steering, retry, and compaction semantics. Verification:
  `packages/janus-agent/tests/chat-turn-maintenance.test.ts` (6 checks:
  prefix order, allowlist intersection without todo/ask, full offering
  without allowlist, maintenance resource resolve without recall/capture,
  recovery skipped read-only, recovery kept with mutation tools),
  existing `chat-turn`/`ask-turn`/`todo-turn` suites stay green (35 checks
  total), `npm run typecheck --workspace=@janus-agent/janus-agent`
  passes. Adopted by JanusX maintenance discussions (see the JanusX
  [unified discussion](../../../../../JanusX/.agents/notes/implemented/architecture/2026-09-17-maintenance-discussion-unified-s6.md)).
- **Costs and limits**: maintenance blueprint reads arrive as a pre-read
  scope snapshot, not an interactive tool; mid-turn drill-down beyond the
  snapshot needs a new turn. The allowlist is caller-owned: a host that
  allows mutation tools gets mutation behavior, and the runner does not
  second-guess it. Revisit when the full engineering tool group
  (prepare/apply asset tools) lands for the execution lane.
