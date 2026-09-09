/**
 * Single-source shim: knowledge shared types live in
 * `@janus-agent/agent-core` (`src/shared/knowledge.ts`, mirroring JanusX
 * `src/shared/knowledge.ts`). Do NOT add local declarations here — this file
 * exists only so intra-package relative imports keep working.
 */
export type {
  KnowledgeContextResult,
  KnowledgeRecallTrace,
} from '@janus-agent/agent-core'
