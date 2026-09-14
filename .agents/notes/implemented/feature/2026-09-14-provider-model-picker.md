# Agent Note: Bare /provider and /model open switcher pickers

Status: implemented

## Problem

Bare `/provider` and `/model` print a static roster and leave the user to retype an exact id for the switch. Every neighboring switcher behaves the opposite way: bare `/effort` opens `EffortPanel`, bare `/approval` opens `ApprovalPanel`, and `/connect` opens the visual setup panel, so Enter performs the switch. The two bare commands are the odd ones out, and typo-prone ids must survive a second round trip before the closed-world validator reports them.

## Decision

Bare `/provider` opens `ProviderPanel` and bare `/model` opens `ModelPanel` in the Ink TUI; the plain loop answers the same bare commands with numbered pickers (`runProviderPicker`, `runModelPicker` in `repl.ts`). Both panels reuse the existing overlay primitives (`PanelFrame`, `SelectedRow`, filter-as-you-type, arrows plus Enter, `Esc` keeps current) and switch on Enter through the same `setProvider` and `setModel` paths that the argument forms use, so validation, persistence, and transport rebuild stay in one place. `ProviderPanel` lists enabled providers with model counts and key status, mirroring the `/connect` roster; `ModelPanel` is scoped to the active provider and probes the live `/models` endpoint first when the catalog is empty, keeping free input only as the fallback when no key exists or the probe fails. Argument forms (`/provider <id>`, `/provider rm <id>`, `/model <id>`) keep their direct semantics for scripts and tests, and the text rosters in `exec.ts` remain as the non-interactive fallback.

## Alternatives considered

- Extend `ConnectPanel` with a switch-only mode — strongest case is zero new components, but the connect flow owns key capture, baseURL editing, probing, and deletion, and dragging switching into it couples viewing to setup side effects the picker must never trigger.
- Keep bare output as text and rely on `/connect` for all switching — strongest case is no new UI state, but `/connect` is a setup wizard (key prompts, reachability probe), which overcharges a plain provider or model change and leaves the plain loop without any picker at all.
- Do nothing / reuse — staying put preserves the status quo, but the inconsistency with `/effort` and `/approval` remains and every switch still costs a manual id round trip.

## Consequences

- **Gains**: Bare `/provider` and `/model` switch in one gesture in both TUI hosts (`packages/cli/src/tui/App.tsx` overlay kinds `provider` and `model`; `packages/cli/src/repl.ts` numbered pickers). Catalog-empty providers list the key's live models with search in both hosts, reusing the `/connect` reachability probe. Full CLI suite passes (37 files, 330 tests) with `tsc --noEmit` clean.
- **Costs and limits**: Two more overlay kinds join the `App.tsx` union, and `ModelPanel` reflects only the active provider, so a provider change requires reopening `/model` for a fresh list. Long model catalogs render untruncated; the revisit signal is filter-plus-truncation in `ModelPanel` once a catalog beyond a screenful appears in practice.
