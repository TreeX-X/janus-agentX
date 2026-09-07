/**
 * @file Host ports for @janus-agent/agent-core
 * @description The core never imports Electron, LLM services, knowledge stores,
 * workspace registries or project runners. Hosts (JanusX shell, janus CLI)
 * inject these capabilities. All ports are structural so hosts don't need to
 * depend on shell-only modules (e.g. office-workspace-guard).
 */

/** Resolve a registered workspace id to its trusted on-disk root. */
export type ResolveWorkspaceRoot = (workspaceId: string) => Promise<string | null>

/** Sink for run/progress events. Shell: webContents.send. CLI: stdout JSONL. */
export type RunEventSink = (channel: string, payload: unknown) => void

/** Minimal IPC event shape (structural subset of Electron's IpcMainInvokeEvent). */
export interface HostIpcEvent {
  sender: { id: unknown }
}

export interface AgentRuntimeFactoryOptions {
  resolveWorkspaceRoot?: ResolveWorkspaceRoot
  auditStore?: import('./runtime/policy-audit-store').PolicyAuditStore
}
