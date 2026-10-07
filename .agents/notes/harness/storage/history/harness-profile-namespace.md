---
{
  "schema": "harness-note/2",
  "id": "a25708f4-6a09-4c18-a3d2-e0e02be42885",
  "kind": "note",
  "lifecycle": "accepted",
  "created": "2026-09-19",
  "updated": "2026-10-07T17:21:40.917Z",
  "module": "note://62b44166-82f0-41ff-838d-e2b02388ed06/ceab8b86-319b-4ba8-9d22-4d43c9e1c12e",
  "extensions": {
    "migration": {
      "source": ".agents/notes/implemented/architecture/2026-09-19-harness-profile-namespace.md",
      "revision": "6feb575bab1b067e6e4d8abc54d1f1d11a7bee23",
      "sourceHash": "07c01bfddbea7e52b5c04055b6d60c64101e7c72739bb4f0cfa487e76bc5b3ef",
      "historical": true
    }
  }
}
---

# Agent Note: Shared Note namespace and pinned profile gate

Historical record retained during v2 migration. Current module entries own the present contract; old execution and verification claims are not new v2 evidence.

Status: implemented

## Problem

Working Notes and formal Harness assets share `.agents/notes`. Treating every Markdown file as a Harness document reports historical prose as invalid, while desktop-only filtering gives the CLI a different answer. A recorded standard digest also offers no compatibility protection unless managed writers and task execution check it.

## Decision

`harness-node/profile.ts` owns namespace detection and repository identity validation. The index marks files without a Harness schema claim as foreign, retaining their paths and byte hashes without parsing them as managed assets. Claims for any `harness-note/` version enter validation, so unsupported versions and broken claimed documents remain diagnostics. Desktop projection and CLI checking consume this same index.

Managed writes, recovery that would change assets, task baselines and execution require `schemaVersion: 1`, a repository UUID, a name and the exact supported profile id, version and digest. `SUPPORTED_HARNESS_PROFILE` pins the LF-normalized WorkFlowX manifest for `workflowx` `1.0.0-s1.1`. Unsupported pins return `UNSUPPORTED_SCHEMA`; invalid identity fields return `SCHEMA_INVALID`. File scans still expose readable Notes and identity diagnostics. The run store preserves the original diagnostic code.

## Alternatives considered

Do nothing and reuse the desktop filter avoids shared API changes, but CLI checks keep rejecting historical prose and future schema versions can disappear from the graph. Moving or converting all working Notes gives a single namespace, but breaks historical links and invents formal assets from prose. An explicit foreign marker preserves the files while limiting managed semantics to claimed assets.

Checking only the profile version is easier to upgrade, but permits different standard bytes under one version. Accepting any profile defers all compatibility errors until writes or receipt evaluation. The exact manifest digest binds this writer to the tested contract; upgrading it requires coordinated consumer and standard validation.

## Consequences

Run `npm run test --workspace @janus-agent/harness-node` and `npm run test --workspace @janus-agent/notes-cli`. `profile.test.ts` checks the standard digest, foreign and future documents, and three incompatible pins against both transactional writers without changing original bytes. CLI tests cover mixed historical assets and future schema diagnostics. Existing fixtures carry complete identities so execution tests exercise the same gate as real repositories.

A Harness file whose schema line is removed appears foreign. Profile changes require an installed writer with a matching pin before managed work resumes. File browsing remains available, but unsupported execution assets cannot claim verified results. This implements a compatibility gate without publishing a standard bundle or activating task-note workflow rules across repositories. Verified 2026-09-19 at this checkout: harness-core 71 tests, harness-node 34 tests, and notes-cli 8 tests pass; all three packages already carry version 0.1.0, and registry publish stays blocked on missing npm credentials. Re-pinned the same day to the sealed standard digest after the final signature (34 harness-node tests still green against the new pin). The entry switch landed the same day: local skill and entry copies now run the WorkFlowX managed rules with dual-surface sync passing, so this checkout enforces task-note semantics for new work while historical prose stays readable. Commands, teammate agents, plugin metadata, and the environment-init module were de-hybridized in the same pass.
