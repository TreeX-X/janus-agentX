---
{
  "schema": "harness-note/2",
  "id": "29375685-c2e4-4ae6-8c70-a14102d13852",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-19",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/86c2d794-3be5-4807-b0fb-1f63c1baa910",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-19-external-runner-launch.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "1cc32d00cb17d21c3a5ff95bb0c18d0f11ec501fdf1637ea38d0a9c8ddfc4548",
      "historical": true
    }
  }
}
---

# Agent Note: External runner launch with recorded history

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

A run prepared for the external executor has no launcher: the kernel writes a factual handoff file, the desktop shows it for copying, and a human retypes the entry by hand. Evidence still lands only as files, but nothing validates the pinned baseline before spawning, nothing records which process went out, and a drifted contract wastes an external run before anyone notices. Provider CLIs take raw program arrays, never shell strings, and that contract has no code behind it.

## Decision

`launchExternalRun` in `packages/cli/src/external-runner.ts` launches external processes for external-executor runs in `queued` or `running` state. It refuses internal runs, settled or verifying runs, runs owned by someone else, and drifted baselines with named diagnostics; a moved contract needs a rebaseline, not a silent retry. The caller supplies the resolved program plus argument array, and the module never shells out: an empty program returns the copyable `janus /harness <uri> --mode <mode>` entry instead of spawning. The working directory resolves inside the checkout, and the default spawner detaches with ignored stdio. Every spawn appends to the run-local launch history in `run-store.ts` (`recordLaunch`/`readLaunches`), newest last; the history never proves completion because process exit stays an event and only files plus the shared kernel decide evidence. `HarnessController.launchExternal` and the `/harness launch --provider <id> -- <program> [args...]` route expose the same behavior in the plain loop.

## Alternatives considered

- Parse the handoff markdown back into launch parameters: reuses the transfer artifact, but the handoff promises no CLI syntax and markdown round-trips are brittle; the launcher revalidates live kernel state and the markdown stays human-readable.
- Resolve providers to programs inside the launcher: strongest case is one-call launching, but provider CLI surfaces live in installer matrices outside this package; the caller resolves once and the launcher stays a pure spawner with array-only execution.
- Mutate run state on launch: would show external activity in the run record, but ownership and progress belong to takeovers, receipts, and repairs; launch records history without touching state, so a second launch reads as history rather than corruption.
- Refuse relaunches while a previous process may live: strongest case is no duplicate external work, but cross-platform aliveness checks are flaky and lease ownership already gates foreign launches; history plus ownership is the honest boundary.
- Do nothing / reuse — keep hand-copied entry commands; rejected because unvalidated baselines burn external runs and no record exists of what went out.

## Consequences

- **Gains**: external preparation closes the loop to a spawned process with baseline, ownership, and state gates plus an inspectable history. Verification: `packages/cli/tests/external-runner.test.ts` (9 checks: spawn with caller array and history, copyable entry without a program, internal/settled/foreign refusals, drifted baseline with zero spawns, bad programs and escaping cwds, relaunch history without state mutation, controller reattach and launch) and the `/harness launch` route. Existing CLI harness, dispatch, and task-execution suites stay green; workspace typecheck and affected builds pass.
- **Costs and limits**: cross-machine launch stays manual through the copied entry; the launcher only serves the checkout it runs in. Provider-to-program resolution lives with the caller (installer matrices, user config); unknown providers take the copyable path by construction. No launch timeout or kill switch: stopping an external process stays an OS action, and its exit never completes a run.
