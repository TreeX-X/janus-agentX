// Note: maintained module adoption - see .agents/notes/harness/workflowx-v2-adoption.md
// Note: shared harness data logic lives here — see .agents/notes/harness/core/history/harness-core-s2.md
/**
 * @janus-agent/harness-core — framework-free harness data logic.
 * No fs, no Electron, no agent loop, no LLM. File IO and execution
 * adapters belong to harness-node and the run hosts (later segments).
 */
export * from './schema.js';
export * from './parse.js';
export * from './markdown.js';
export * from './serialize.js';
export * from './relations.js';
export * from './hash.js';
export * from './lifecycle.js';
export * from './task-state.js';
export * from './receipt.js';
export * from './changeset.js';
export * from './execution-policy.js';
export * from './review-tests.js';

export * from './note-edit.js';
