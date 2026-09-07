import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PolicyAuditQuery, PolicyDecisionRecord } from '../../../shared/ipc/agent-runtime'

export interface PolicyAuditStore {
  record(record: PolicyDecisionRecord): Promise<void>
  query(query?: PolicyAuditQuery): Promise<PolicyDecisionRecord[]>
}

function matches(record: PolicyDecisionRecord, query: PolicyAuditQuery): boolean {
  return (!query.workspaceId || record.workspaceId === query.workspaceId)
    && (!query.sessionId || record.sessionId === query.sessionId)
    && (!query.correlationId || record.correlationId === query.correlationId)
}

export class MemoryPolicyAuditStore implements PolicyAuditStore {
  private readonly records: PolicyDecisionRecord[] = []
  async record(record: PolicyDecisionRecord): Promise<void> { this.records.push(structuredClone(record)) }
  async query(query: PolicyAuditQuery = {}): Promise<PolicyDecisionRecord[]> {
    return this.records.filter((record) => matches(record, query)).map((record) => structuredClone(record))
  }
}

let writeQueue = Promise.resolve()

export const POLICY_AUDIT_ENV = 'JANUSX_AUDIT_ROOT'

function defaultUserDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'JanusX')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'JanusX')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'JanusX')
}

/**
 * Standalone equivalent of the shell's knowledgeRootPath()/audit layout.
 * Hosts should prefer passing an explicit rootDir; this default only keeps
 * single-host (desktop) behaviour identical to JanusX.
 */
export function resolveDefaultAuditDir(): string {
  const override = process.env[POLICY_AUDIT_ENV]?.trim()
    || process.env.JANUSX_KNOWLEDGE_ROOT?.trim()
  if (override) return join(override, 'audit')
  return join(defaultUserDataDir(), 'janusx', 'knowledge', 'audit')
}

export class FilePolicyAuditStore implements PolicyAuditStore {
  private readonly path: string
  constructor(rootDir: string = resolveDefaultAuditDir()) {
    this.path = join(rootDir, 'workspace-policy.jsonl')
  }
  async record(record: PolicyDecisionRecord): Promise<void> {
    const operation = writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    writeQueue = operation.catch(() => undefined)
    return operation
  }
  async query(query: PolicyAuditQuery = {}): Promise<PolicyDecisionRecord[]> {
    let content = ''
    try { content = await readFile(this.path, 'utf8') } catch { return [] }
    return content.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        const record = JSON.parse(line) as PolicyDecisionRecord
        return matches(record, query) ? [record] : []
      } catch { return [] }
    })
  }
}

/** Explicit factory for hosts that manage their own data root (CLI, tests). */
export function createFilePolicyAuditStore(rootDir: string): FilePolicyAuditStore {
  return new FilePolicyAuditStore(rootDir)
}
