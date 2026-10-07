// Note: shared compression retains original history and source references — see .agents/notes/harness/storage/history/workflowx-runtime.md
/** Host-produced checkpoint. Original messages remain in the conversation journal. */
export interface ChatContextCheckpoint {
  summary: string
  coveredMessages: number
  prefixHash: string
  scopeKey: string
  references?: string[]
}

export interface ChatContextStatus {
  phase: 'ready' | 'compacting' | 'compacted' | 'failed'
  usedTokens: number
  windowTokens: number
  source: 'configured' | 'catalog' | 'registry' | 'estimated'
  checkpoint?: ChatContextCheckpoint
}
