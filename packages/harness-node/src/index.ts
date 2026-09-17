// Note: managed note storage lives here — see .agents/notes/implemented/architecture/2026-09-16-harness-node-cli-s3.md
/**
 * @janus-agent/harness-node — Node file adapter for harness notes.
 * Transacted writes, journal recovery, checkout resolve, watcher facts,
 * git evidence. No agent-core, no Electron, no LLM.
 */
export * from './repository.js';
export * from './baseline.js';
export * from './resolver.js';
export * from './journal.js';
export * from './transaction.js';
export * from './watcher.js';
export * from './git-evidence.js';
