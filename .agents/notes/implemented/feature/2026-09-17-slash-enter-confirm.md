# Agent Note: Slash Enter confirms incomplete commands before sending

Status: implemented

## Problem

A leading `/` opens the command popover, yet `Enter` submits the raw buffer without consulting the highlight. Partial input such as `/mo` or `/sta` therefore lands in the executor as `unknown command`, while `Up/Down` navigation has no effect on `Enter`. Every other picker in the TUI confirms with arrows plus `Enter`, so the composer is the inconsistent one, and the extra `Tab`-then-`Enter` step stays undiscoverable.

## Decision

`Enter` confirms the highlighted completion in place when the first token is an incomplete `/` command; a second `Enter` submits. Exact known commands (case-insensitive) and a bare `/` submit directly, preserving the one-key path for fully typed input. `Esc` dismisses the list and keeps the submit-raw escape hatch, `Tab` keeps its apply-without-submit semantics, and busy or disabled input never shows the list. The rule lives in the pure `shouldConfirmCompletion` helper in `packages/cli/src/tui/composer-state.ts`, and `packages/cli/src/tui/Composer.tsx` routes `Enter` through it inside the visible-list branch.

## Alternatives considered

- Execute the highlight immediately on `Enter` (single-stage) — strongest case is one fewer keystroke, but destructive commands (`/delete`, `/workspace`) run before the user reviews arguments, and argument-bearing commands lose their editing step.
- Keep `Enter` always submitting — strongest case is zero change with the fastest exact-command path, but partial input always errors and highlight navigation stays dead, so discoverability never improves.
- Do nothing / reuse `Tab` only — staying put avoids all churn, but the inconsistency with `ProviderPanel`, `ModelPanel`, `EffortPanel`, and the question panel remains, and `Tab` stays undiscoverable on terminals where it moves focus.

## Consequences

- **Gains**: Partial slash input completes on `Enter` (`/sta` becomes `/status `) instead of surfacing `unknown command`; exact input (`/status`) still sends on one `Enter`. Full CLI suite passes (37 files, 357 tests) with `tsc --noEmit` clean, and the packed bundle carries the rule into the global `janus` install.
- **Costs and limits**: Incomplete tokens cost two `Enter` presses (confirm, then send) by design. The plain readline loop keeps `Tab`-only completion because it has no persistent highlight state; the revisit signal is a shared confirm helper if the plain loop ever gains a visible list.
