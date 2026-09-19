# Agent Note: Shared Note namespace and pinned profile gate

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

A Harness file whose schema line is removed appears foreign. Profile changes require an installed writer with a matching pin before managed work resumes. File browsing remains available, but unsupported execution assets cannot claim verified results. This implements a compatibility gate without publishing a standard bundle or activating task-note workflow rules across repositories. Verified 2026-09-19 at this checkout: harness-core 71 tests, harness-node 34 tests, and notes-cli 8 tests pass; all three packages already carry version 0.1.0, and registry publish stays blocked on missing npm credentials.
