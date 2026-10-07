---
{
  "schema": "harness-note/2",
  "id": "be583dc5-1d9e-4f4c-8d52-a16aa8645342",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-17",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ceab8b86-319b-4ba8-9d22-4d43c9e1c12e",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-17-harness-repo-identity-s7.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "7337d1b20a9f172bc684d3835c0df73138315b3bfb10f60505b6467c411b1069",
      "historical": true
    }
  }
}
---

# Agent Note: janus-agentX repo identity for the harness

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

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
  [shared namespace and profile gate](harness-profile-namespace.md),
  without migration or invalid diagnostics. Managed writes and execution
  require the exact supported standard version and digest. The pin must
  move with tested consumer support whenever the standard changes; sibling
  checkouts retain their own repository identities.
