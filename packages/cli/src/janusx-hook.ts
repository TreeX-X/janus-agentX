/**
 * @file JanusX hook emission for the janus CLI (terminal running-state integration).
 * @description Env-gated: without `JANUSX_HOOK_PORT`/`JANUSX_HOOK_TOKEN` every
 * entry is a silent no-op, so standalone `janus tui` runs are unaffected.
 * Payloads reuse the Claude hook event names (`UserPromptSubmit`, `Stop`,
 * `StopFailure`, `PermissionRequest`, `Notification`, `SessionEnd`) plus the
 * `janusx.turn.*` synthetic namespace, so JanusX needs no per-engine branch.
 * Delivery failures never break the CLI: the bridge is best-effort.
 */

const HOOK_POST_TIMEOUT_MS = 2_000
const HOOK_MESSAGE_LIMIT = 500

export interface JanusxHookInput {
  event: string
  sessionId?: string
  cwd?: string
  message?: string
  raw?: unknown
  env?: NodeJS.ProcessEnv
}

interface HookEndpoint {
  port: string
  token: string
  terminalId?: string
  workspaceId?: string
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && value.trim() ? value.trim() : undefined
}

function resolveEndpoint(env: NodeJS.ProcessEnv): HookEndpoint | null {
  const port = readEnv(env, 'JANUSX_HOOK_PORT')
  const token = readEnv(env, 'JANUSX_HOOK_TOKEN')
  if (!port || !token) return null
  return {
    port,
    token,
    terminalId: readEnv(env, 'JANUSX_HOOK_TERMINAL_ID'),
    workspaceId: readEnv(env, 'JANUSX_HOOK_WORKSPACE_ID'),
  }
}

export function truncateHookMessage(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (!text) return undefined
  return text.length > HOOK_MESSAGE_LIMIT ? text.slice(0, HOOK_MESSAGE_LIMIT) : text
}

export async function postJanusxHook(input: JanusxHookInput): Promise<void> {
  try {
    const endpoint = resolveEndpoint(input.env ?? process.env)
    if (!endpoint || !input.event) return

    const body = JSON.stringify({
      source: 'janus',
      event: input.event,
      terminalId: endpoint.terminalId,
      workspaceId: endpoint.workspaceId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      message: truncateHookMessage(input.message),
      timestamp: new Date().toISOString(),
      raw: input.raw ?? null,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HOOK_POST_TIMEOUT_MS)
    try {
      await fetch(`http://127.0.0.1:${endpoint.port}/api/agent-hook`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      }).catch(() => undefined)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // Hook delivery must never break the CLI.
  }
}
