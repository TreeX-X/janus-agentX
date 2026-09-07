import { createHash, randomUUID } from 'node:crypto'
import type { HostIpcEvent } from '../ports'
import type { ActionRisk, ApprovalPreview } from '../../../shared/ipc/agent-runtime'
import { createPolicyDecisionRecord, evaluateWorkspaceActionPolicy, settleApprovalDecision } from './policy-gate'
import { MemoryPolicyAuditStore, type PolicyAuditStore } from './policy-audit-store'

export interface RendererActionRequest {
  workspaceRoot: string
  toolName: string
  actionRisk: ActionRisk
  preview: ApprovalPreview
  /**
   * 'renderer-user' 标记来自渲染进程的显式用户操作（文件树右键菜单、编辑器 Ctrl+S 等）。
   * 这类操作已由前端 UI 完成首次用户确认，主进程无需再次弹出原生审批对话框；
   * 仅记录审计日志，敏感路径拒绝与只读放行规则保持不变。
   */
  source?: 'renderer-user'
}

export type RendererActionAuthorizer = (event: HostIpcEvent, request: RendererActionRequest) => Promise<boolean>

export function createRendererActionAuthorizer(auditStore: PolicyAuditStore = new MemoryPolicyAuditStore()): RendererActionAuthorizer {
  return async (event, request) => authorizeRendererActionWithStore(event, request, auditStore)
}

/** Default authorizer (memory audit). Hosts needing persistence: use the factory. */
export const authorizeRendererAction: RendererActionAuthorizer = createRendererActionAuthorizer()

async function authorizeRendererActionWithStore(event: HostIpcEvent, request: RendererActionRequest, auditStore: PolicyAuditStore): Promise<boolean> {
  const workspaceId = `legacy:${createHash('sha256').update(request.workspaceRoot).digest('hex').slice(0, 16)}`
  const sessionId = `renderer:${String((event.sender as { id?: unknown } | undefined)?.id ?? 'unknown')}`
  const correlationId = randomUUID()
  const initial = evaluateWorkspaceActionPolicy({ actionRisk: request.actionRisk })
  const base = { workspaceId, sessionId, correlationId, toolName: request.toolName, toolInput: { preview: request.preview } }

  if (initial.outcome !== 'approval-required') {
    await auditStore.record({ ...createPolicyDecisionRecord({ ...base, decision: initial }), provenance: 'manual-user' })
    return initial.outcome === 'allow'
  }

  // Renderer commands are approved only after an explicit JanusX UI action. Unmarked
  // calls fail closed instead of falling back to an Electron-native confirmation.
  const outcome = request.source === 'renderer-user' ? 'approved' : 'denied'
  await auditStore.record({
    ...createPolicyDecisionRecord({ ...base, decision: settleApprovalDecision(initial, outcome) }),
    provenance: 'manual-user',
  })
  return outcome === 'approved'
}
