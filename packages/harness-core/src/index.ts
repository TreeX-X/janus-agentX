// Note: shared harness data logic lives here — see .agents/notes/implemented/architecture/2026-09-16-harness-core-s2.md
/**
 * @janus-agent/harness-core — framework-free harness data logic.
 * No fs, no Electron, no agent loop, no LLM. File IO and execution
 * adapters belong to harness-node and the run hosts (later segments).
 */
export * from './schema.js';
export * from './parse.js';
export * from './serialize.js';
export * from './relations.js';
export * from './hash.js';
export * from './lifecycle.js';
export * from './task-state.js';
export * from './receipt.js';
export * from './changeset.js';
