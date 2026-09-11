/**
 * Phase2 contract: model-facing tool names are a cross-repo API.
 * Blueprint's BLUEPRINT_READ_ONLY_MODEL_TOOLS whitelist and chat prompts
 * filter on these providerNames; a rename silently disables tools.
 * Any change here must be synced with the JanusX shell in the same release.
 */
import { describe, expect, it } from 'vitest'
import { createToolPreview, createWorkspaceChatTools } from '../src/main/agent/chat-tools/workspace-chat-tools'

const ALL_MODEL_TOOLS = [
  'workspace_list', 'workspace_search', 'workspace_read', 'workspace_edit', 'workspace_create',
  'workspace_delete',
  'project_detect', 'project_generate_config', 'project_apply_config',
  'project_list_processes', 'project_process_output',
  'project_start_process', 'project_stop_process',
  'git_status', 'git_log', 'git_diff', 'git_stage', 'git_unstage',
  'git_commit', 'git_pull', 'git_push',
  'command_run',
]

/** Must equal JanusX maintenance/service.ts BLUEPRINT_READ_ONLY_MODEL_TOOLS. */
const BLUEPRINT_READ_ONLY_MODEL_TOOLS = [
  'workspace_list', 'workspace_search', 'workspace_read',
  'project_detect', 'project_list_processes', 'project_process_output',
  'git_status', 'git_log', 'git_diff',
]

function buildTools() {
  return createWorkspaceChatTools({
    runtime: { executeFunctionCall: async () => ({ status: 'completed' }) as never },
    resources: new Map(),
    callerId: 'contract-test',
  })
}

describe('model tool-name contract', () => {
  it('exposes exactly the 22 documented model tools', () => {
    expect(Object.keys(buildTools()).sort()).toEqual([...ALL_MODEL_TOOLS].sort())
  })

  it('keeps every blueprint read-only tool available', () => {
    const names = new Set(Object.keys(buildTools()))
    for (const name of BLUEPRINT_READ_ONLY_MODEL_TOOLS) {
      expect(names.has(name), `blueprint tool missing: ${name}`).toBe(true)
    }
  })

  it('unattached workspaces fail closed with a model-readable error', async () => {
    const tools = buildTools()
    const result = await tools.workspace_read.execute({
      workspaceId: 'ghost', path: 'a.ts', offset: 0, maxBytes: 128,
    })
    expect((result as { ok: boolean }).ok).toBe(false)
  })

  it('previews stay bounded for approval dialogs', () => {
    const preview = createToolPreview('workspace.edit', {
      path: 'a.ts',
      replacements: [{ oldText: 'x'.repeat(10_000), newText: 'y'.repeat(10_000) }],
    })
    expect(preview?.summary).toContain('Edit a.ts')
    expect((preview?.detail?.length ?? 0)).toBeLessThanOrEqual(4_000)
    expect(createToolPreview('workspace.read', { path: 'a.ts' })).toBeUndefined()
  })

  it('builds a bounded delete preview naming the target and scope', () => {
    const preview = createToolPreview('workspace.delete', { path: 'old/', recursive: true })
    expect(preview?.summary).toBe('Delete old/ (recursive)')
    expect(preview?.paths).toEqual(['old/'])
    expect((preview?.detail?.length ?? 0)).toBeLessThanOrEqual(4_000)
    const plain = createToolPreview('workspace.delete', { path: 'old.md' })
    expect(plain?.summary).toBe('Delete old.md')
  })
})
