# Agent Note: janus-agentX repo identity for the harness

Status: implemented

## Problem

The execution-host checkout had no repository identity: the note index
reported a null repo id, so no `note://` URI could be minted here and no
cross-repo reference could target this tree. Task handoff files, future
receipts, and evidence manifests all need a stable repo address, and
identity setup stayed open while the core, node, and CLI segments already
landed.

## Decision

`.agents/harness.json` carries `schemaVersion: 1`, a stable repo id,
the name janus-agentX, and a profile pinning the consumed standard
`1.0.0-s1.1` with the manifest digest (SHA-256 over LF-normalized manifest
bytes of the WorkFlowX bundle). The repo id is a fresh UUID: ordinary
clones keep it, renames and moves never change it, and a fork that joins
the same blueprint graph mints a new one while recording its source.
Dependency repositories stay omitted because no dependency has published
an identity from this side.

## Alternatives considered

- Derive the identity from the checkout path — strongest case is zero new
  files, but moves and renames fork every existing reference, including
  future handoff files and receipts; a stored UUID survives both.
- Reuse a sibling checkout identity — strongest case is one id to manage,
  but the execution host needs its own URI space or its evidence merges
  into another repo's graph by accident.
- Convert the old-format notes now — strongest case is a fully valid
  index, but bulk rewrites belong to the S9 migration, not to identity
  setup; the files stay readable legacy.
- Do nothing / reuse — leave the checkout identity-less; rejected because
  handoff and evidence records would reference an unresolvable repo.

## Consequences

- **Gains**: the checkout resolves an identity for future handoff and
  evidence addressing. Verification: read-only rescan reports
  `repoId=62b44166-82f0-41ff-838d-e2b02388ed06` with 45 scanned entries;
  `npm run typecheck --workspace=@janus-agent/harness-node` passes.
- **Costs and limits**: historical working Notes stay foreign under the
  [shared namespace and profile gate](2026-09-19-harness-profile-namespace.md),
  without migration or invalid diagnostics. Managed writes and execution
  require the exact supported standard version and digest. The pin must
  move with tested consumer support whenever the standard changes; sibling
  checkouts retain their own repository identities.
