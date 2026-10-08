// Note: maintained module adoption - see .agents/notes/harness/workflowx-v2-adoption.md
// Note: managed note storage lives here — see .agents/notes/harness/storage/history/harness-node-cli-s3.md
/**
 * @janus-agent/harness-node — Node file adapter for harness notes.
 * Transacted writes, journal recovery, checkout resolve, watcher facts,
 * git evidence. No agent-core, no Electron, no LLM.
 */
export * from './repository.js';
export * from './references.js';
export * from './profile.js';
export * from './baseline.js';
export * from './task-snapshot.js';
export * from './task-scope.js';
export * from './task-result.js';
export * from './resolver.js';
export * from './journal.js';
export * from './transaction.js';
export * from './watcher.js';
export * from './git-evidence.js';

export * from './note-types.js';

export * from './note-provider.js';

export * from './note-index-patch.js';

export * from './share-import.js';

export * from './note-service.js';

export * from './undo.js';

export * from './note-editor.js';
export * from './init.js';

export * from './task-handoff.js';
export * from './review-tests.js';
export * from './module-structure.js';
