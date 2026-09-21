import type { CheckpointEngine } from '../../../shared/ipc/checkpoint'
export type { CheckpointEngine } from '../../../shared/ipc/checkpoint'
export type { ChangedFileRecord, ChangedFileStatus, RestoreScope } from '../../../shared/ipc/checkpoint'

export interface SnapshotFileEntry {
  path: string
  hash: string
  size: number
}

export interface ConversationCheckpoint {
  id: string
  terminalId: string
  conversationIndex: number
  createdAt: string
  engine: CheckpointEngine
  branch: string
  prompt: string
  filesSnapshot: Record<string, SnapshotFileEntry>
  status: 'ready'
  schemaVersion: 2
  /** Stable session binding (survives terminal restarts; terminalId is volatile). */
  sessionId?: string
  /** Turn that produced this checkpoint, when created on a turn boundary. */
  turnId?: string
  /** Completion kind of the producing turn. */
  kind?: 'done' | 'failed' | 'interrupted'
  /** Reserved worktree identity; empty until worktree isolation lands. */
  worktreeId?: string
  /** Previous checkpoint id in the owning session chain. */
  parentId?: string
}

/** Untracked files at or above this size are recorded without content blobs. */
export const OVERSIZED_BLOB_BYTES = 2 * 1024 * 1024

export interface ConflictInfo {
  filePath: string
  resolution: 'snapshot'
}

export interface CheckpointCreateOptions {
  terminalId: string
  engine: CheckpointEngine
  prompt: string
  cwd: string
  sessionId?: string
  turnId?: string
  kind?: 'done' | 'failed' | 'interrupted'
  worktreeId?: string
  parentId?: string
}
