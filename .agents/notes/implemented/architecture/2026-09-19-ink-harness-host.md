# Agent Note: Ink harness host behind the shared adapter

Status: implemented

## Problem

The Ink loop lists a `harness` command with a real hint, but its host object carries no harness adapter: every `/harness` invocation answers that the mode is unavailable. The plain REPL drives the full task lifecycle through `createHarnessHost`, while Ink owns its own session replacement and rendering and cannot share the plain controller instance. Execution ports need the live session and a turn abort signal, and a stale aborted signal would poison later verification with instant aborts.

## Decision

`createInkHarnessHost` in `packages/cli/src/tui/harness-host.ts` builds an Ink-owned `HarnessController` and wraps it with the same shared command adapter the plain loop uses, so both surfaces keep byte-identical command semantics. Workspace root, verification ports, and the abort signal all read the live Ink session through accessors, so workspace switches and session replacement never strand the binding; an already-aborted turn signal resolves to no signal instead of failing the next verification. Command output flows through the existing outcome lines with no new rendering. The `App` root constructs one host and passes it into the shared executor, which routes `/harness` and `/exit` through it like the plain loop. Ordinary message submission also passes through `executeTurn`: an active task receives the fixed task context, scoped tools and separate task history. A paused task refuses before the model call, and cancellation pauses the task through the controller. Workspace changes continue to resolve through the live session accessor.

## Alternatives considered

- Share the plain-loop controller directly with Ink: one instance for both surfaces, but Ink owns session replacement and rendering; a workspace switch in one loop would silently move the other's binding, which the execution host explicitly forbids.
- Reimplement command parsing for Ink: full control over presentation, but duplicates the argv grammar and drifts from the plain loop on the first new flag; the shared adapter keeps one grammar.
- Skip execution ports and expose status only: smallest wiring, but verification, repair, and closeout stay plain-loop-only and the Ink loop cannot complete the cycle it advertises.
- Do nothing / reuse — keep reporting the mode unavailable; rejected because the advertised command then stays permanently dead in the primary interactive surface.

## Consequences

- **Gains**: `/harness` in Ink enters tasks, runs status and verification, spends the automatic repair budget on failure, and exits the mode through the same controller the plain loop uses. Verification: `packages/cli/tests/tui-harness-host.test.ts` (6 checks covering mode-off routing, task lifecycle, ordinary/task history isolation, paused refusal and cancellation, and real model writes inside scope, outside scope and into protected Notes) with a ports override seam for deterministic review. Existing TUI executor, CLI harness, and dispatch suites stay green; workspace typecheck passes.
- **Costs and limits**: runs render as outcome lines; dedicated status cards and pickers remain separate work. Execution and verification commands receive fresh abort controllers, and queued input returns to the composer when they settle. The [delegated execution policy](2026-09-19-delegated-task-hosts.md) owns xdel/xflow behavior across both CLI entrances. Manual verification evidence remains unavailable in CLI.
