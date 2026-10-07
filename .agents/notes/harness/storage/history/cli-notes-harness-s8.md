---
{
  "schema": "harness-note/2",
  "id": "f3521e93-85e4-4a53-b1bc-5281f2c9fb1e",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-17",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ceab8b86-319b-4ba8-9d22-4d43c9e1c12e",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-17-cli-notes-harness-s8.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "2b73e637c64538e7d424e0cd236ccdd30d91090940aac8fb5645ba5091469124",
      "historical": true
    }
  }
}
---

# Agent Note: janus notes reuses the notes-cli command functions

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

`wfx-notes` owns the offline note operations while the `janus` CLI has
no note entry at all, so terminal users maintain notes through a second
binary with its own parsing. A hand-written second implementation would
fork exit codes, envelopes, and file results on the first divergence,
which is exactly the dual-source drift the harness standard removes.

## Decision

`janus notes [--root <dir>] [--json] <list|show|create|check|apply>`
routes through the same exported command functions
(`cmdList/cmdShow/cmdCreate/cmdCheck/cmdApply`) with the same `exitFor`
codes and the same `--json` envelope; only argv parsing, the usage text,
and human rendering live in `packages/cli/src/notes.ts`. The notes-cli
package exposes its command module as the library entry so the janus CLI
imports functions, never file paths. Unreadable changesets stay
`SCHEMA_INVALID` (exit 2) in both CLIs because the shared function
returns the diagnostic instead of throwing; only runner-side IO (a
missing body file) exits 5.

## Alternatives considered

- Reimplement the operations inside the janus CLI — strongest case is no
  cross-package dependency, but every schema, code, and message fix then
  ships twice and the two binaries disagree within a release.
- Shell out to the `wfx-notes` binary — strongest case is zero new code,
  but it couples the janus CLI to an installed sibling binary and hides
  the envelope behind process plumbing; a function call keeps one
  dependency closure.
- Share only the exit codes and rewrite the logic — strongest case is
  freedom in rendering, but file results would still fork; sharing the
  functions shares the results too.
- Do nothing / reuse — keep `wfx-notes` as the only note CLI; rejected
  because janus terminal users then maintain project assets outside the
  tool that will also run their tasks.

## Consequences

- **Gains**: one implementation serves both CLIs with identical results
  and envelopes. Verification: `packages/cli/tests/notes.test.ts` (5
  checks: argv passthrough plus help, list/show/check roundtrip with a
  minted note URI, create through the shared function, fixed exit-code
  mapping), `npm run typecheck --workspace=@janus-agent/cli` passes.
- **Costs and limits**: human-readable lines may differ cosmetically
  between the binaries; only the `--json` envelope and the file results
  are contract-identical. The notes group is modeless and runs no turns;
  task execution stays with the harness mode slice. Revisit when the
  harness run commands need the same treatment.
