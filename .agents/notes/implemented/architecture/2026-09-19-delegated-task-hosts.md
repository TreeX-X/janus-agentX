# Agent Note: Delegated task execution across CLI hosts

Status: implemented

## Problem

Delegated task modes need executable roles and evidence. A mode label cannot establish that an implementor has isolated history, that an evaluator lacks write permission, or that the receipt describes the tested files. Failed independent review also needs concrete repair guidance even when command checks pass.

## Decision

`harness-core/execution-policy` defines deterministic task role identities and mode policy for peer CLI and desktop hosts. The lease owner coordinates the run; delegated implementors and evaluators have separate role identifiers. The [task execution host](2026-09-18-harness-task-execution.md) accepts internal xdo, xdel and xflow. Each CLI model turn receives its own runtime session, task history, scoped tools, current approval mode and configured tool timeout. Cancellation drains that session without terminating ordinary chat.

Plain and Ink expose `/harness execute` through one controller. It implements running attempts and verifies them; retrying a verifying run does not repeat implementation. Ordinary task messages remain implementation turns, and `/harness verify` remains an explicit verification-only action. xdel invokes self-review once and never invokes automatic independent review or repair. xflow follows self-review with a fresh evaluator context, checks and final independent evidence; only the independent verdict enters its formal receipt. The evaluator receives pinned Notes, the full tested manifest and check output, without previous verdicts or implementation history. Its only tool is direct file reading; task histories and ledgers are inaccessible. Every file call rechecks lease, attempt and baseline. The final receipt retains the implementor as author and the evaluator as review actor.

The [repair scheduler](2026-09-19-harness-auto-repair.md) reopens xflow on required-check failure or independent needs-fix, subject to the run budget, defaulting to one automatic repair. xdel stays verifying until explicit repair. Blocked evidence, code drift, malformed claims and unavailable capabilities never initiate automatic repair. Optional `review.summary`, bounded to 4000 characters, retains concrete findings in immutable evidence and the next implementation receives the failure receipt. Existing receipts without the field remain valid. Implementation tool failures refuse verification.

Ink assigns a fresh abort controller to execution and verification commands, blocks concurrent command submission, and restores messages queued during those commands to the input. The [Ink host](2026-09-19-ink-harness-host.md) owns its session accessor while sharing command semantics with plain CLI.

## Alternatives considered

Reuse the xdo guard and retain unsupported mode messages: minimal maintenance, but leaves accepted tasks unrunnable. Reuse one conversation for implementation and evaluation: cheaper context management, but cannot support independent evidence. Separate OS processes for every agent: stronger failure isolation, but unnecessary for scoped model contexts and introduces a second persistence protocol.

## Consequences

The same configured model fills both roles in CLI; independence means separate context and capability, not different model weights or a security boundary between processes. This host executes one accepted task in one checkout. Task graph scheduling, manual verification evidence in CLI, nested delegation and cross-checkout execution require separate capabilities. Declared commands remain trusted checkout code. Recovery retains run state and task histories, not active model protocol streams. A broader evaluator toolset requires preserving the history exclusion; direct reads deliberately trade convenience for a small inspectable boundary.

Verification: `npm test --workspace=@janus-agent/harness-core -- tests/receipt.test.ts` covers 12 receipt checks; `npm test --workspace=@janus-agent/janus-agent -- tests/task-execution.test.ts tests/harness-auto-repair.test.ts tests/harness-portable-results.test.ts tests/harness-dispatch.test.ts` covers 55 host, repair, kernel and portable-result checks. `npm test --workspace=@janus-agent/cli -- tests/harness-mode.test.ts tests/tui-harness-host.test.ts tests/tui-harness-command.test.tsx` covers real plain/Ink session routing, file tools, receipt identities and cancellation. Typecheck and builds cover the three changed packages. The [desktop peer](../../../../../JanusX/.agents/notes/implemented/architecture/2026-09-19-desktop-delegated-modes.md) owns desktop acceptance and endpoint recovery.
