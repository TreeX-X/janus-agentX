import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectWorkflowX } from '../src/workflowx-detection.js'

let home: string
let workspace: string
const marker = '<!-- wfx-managed: workflowx-entry -->\n# WorkflowX\n<!-- wfx-managed-end -->'
const plugin = JSON.stringify({ name: 'workflowx', version: '99.0.0', repository: 'https://github.com/TreeX-X/workflowX' })
async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
const detect = () => detectWorkflowX({ homeDir: home, workspacePath: workspace })
beforeEach(async () => {
  vi.stubEnv('CODEX_HOME', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  // Undefined, rather than empty, models an unset environment override.
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  home = await mkdtemp(join(tmpdir(), 'workflowx-detect-'))
  workspace = join(home, 'project')
  await mkdir(workspace)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

describe('WorkflowX import recognition', () => {
  it('does not treat directories, Note initialization or README examples as imports', async () => {
    await mkdir(join(workspace, '.claude'))
    await put(join(workspace, 'README.md'), marker)
    await put(join(workspace, '.agents/harness.json'), '{"profile":{"id":"workflowx"}}')
    expect((await detect()).status).toBe('missing')
  })
  it.each(['claude', 'codex'] as const)('detects global %s without a workspace', async format => {
    await put(join(home, `.${format}`, format === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), marker)
    const result = await detectWorkflowX({ homeDir: home })
    expect(result.status).toBe('detected')
    expect(result.sources).toMatchObject([{ format, scope: 'global', reason: 'entry' }])
  })
  it.each(['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'])('either workspace format suffices: %s', async file => {
    await put(join(workspace, file), marker)
    expect((await detect()).status).toBe('detected')
  })
  it('keeps global evidence while switching to an empty workspace', async () => {
    await put(join(home, '.codex/AGENTS.md'), marker)
    await put(join(workspace, 'CLAUDE.md'), marker)
    expect((await detect()).sources).toHaveLength(2)
    const result = await detectWorkflowX({ homeDir: home, workspacePath: join(home, 'other') })
    expect(result.sources).toHaveLength(1)
    expect(result.status).toBe('detected')
  })
  it.each(['```md\n', '~~~~\n', '    ', '> '])('ignores example marker %s', async prefix => {
    const text = prefix.includes('\n') ? `${prefix}${marker}\n${prefix.trim()}` : marker.split('\n').map(line => prefix + line).join('\n')
    await put(join(workspace, 'AGENTS.md'), text)
    expect((await detect()).status).toBe('missing')
  })
  it('returns uncertain for legacy references and incomplete markers', async () => {
    await put(join(workspace, 'AGENTS.md'), '<!-- wfx-managed: workflowx-entry -->\nUse WorkflowX')
    expect((await detect()).status).toBe('uncertain')
  })
  it('honors Codex instruction override precedence', async () => {
    await put(join(workspace, 'AGENTS.md'), marker)
    await put(join(workspace, 'AGENTS.override.md'), 'Use custom instructions')
    expect((await detect()).status).toBe('missing')
  })
  it.each(['claude', 'codex'])('recognizes a deployed %s routing skill independent of version or inventory', async format => {
    await put(join(home, `.${format}/skills/orchestrateX/SKILL.md`), '---\nname: orchestrateX\ndescription: arbitrary future description\n---\n# Router')
    expect((await detect()).sources).toMatchObject([{ reason: 'skill', status: 'detected' }])
  })
  it('uses configured global roots', async () => {
    vi.stubEnv('CODEX_HOME', join(home, 'custom'))
    await put(join(home, 'custom/AGENTS.md'), marker)
    expect((await detect()).status).toBe('detected')
  })
  it('does not take a skill identity from an example outside frontmatter', async () => {
    await put(join(home, '.codex/skills/orchestrateX/SKILL.md'), '---\nname: somethingElse\n---\n```yaml\nname: orchestrateX\n---\n```')
    expect((await detect()).status).toBe('uncertain')
  })
  it('reports incomplete plugin registrations without inventing a workspace source', async () => {
    await put(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'workflowx@official': [{ scope: 'user', installPath: join(home, 'missing') }] } }))
    await put(join(home, '.codex/config.toml'), '[plugins."workflowx@official"]\nenabled = true')
    const result = await detect()
    expect(result.status).toBe('uncertain')
    expect(result.sources.every(source => source.scope === 'global')).toBe(true)
  })
  it('treats malformed configuration and oversized instruction entries as uncertain', async () => {
    await put(join(home, '.claude/settings.json'), '{broken')
    await put(join(workspace, 'AGENTS.md'), 'x'.repeat(256 * 1024 + 1))
    const result = await detect()
    expect(result.status).toBe('uncertain')
    expect(result.sources.every(source => source.reason === 'unreadable')).toBe(true)
  })
  it('known evidence wins over an unreadable second format', async () => {
    await put(join(workspace, 'CLAUDE.md'), marker)
    await put(join(home, '.codex/config.toml'), 'broken = [')
    expect((await detect()).status).toBe('detected')
  })
  it('recognizes a registered Claude plugin but rejects another project installation', async () => {
    const installPath = join(home, 'plugin')
    await put(join(installPath, '.claude-plugin/plugin.json'), plugin)
    const registry = (scope: string, projectPath?: string) => JSON.stringify({ plugins: { 'workflowx@official': [{ scope, projectPath, installPath }] } })
    await put(join(home, '.claude/plugins/installed_plugins.json'), registry('user'))
    expect((await detect()).status).toBe('detected')
    await put(join(home, '.claude/plugins/installed_plugins.json'), registry('project', join(home, 'elsewhere')))
    expect((await detect()).status).toBe('missing')
    await put(join(home, '.claude/plugins/installed_plugins.json'), registry('project', workspace))
    expect((await detect()).sources).toMatchObject([{ scope: 'workspace', reason: 'plugin' }])
  })
  it('requires activation for a cached Codex plugin and respects disable', async () => {
    await put(join(home, '.codex/plugins/cache/official/workflowx/99/.codex-plugin/plugin.json'), plugin)
    expect((await detect()).status).toBe('uncertain')
    await put(join(home, '.codex/config.toml'), '[plugins."workflowx@official"]\nenabled = true')
    expect((await detect()).status).toBe('detected')
    await put(join(workspace, '.codex/config.toml'), '[plugins."workflowx@official"]\nenabled = false')
    expect((await detect()).status).toBe('uncertain')
    expect((await detect()).sources.some(source => source.reason === 'disabled')).toBe(true)
  })
  it('does not certify a missing or unrelated plugin from its name alone', async () => {
    await put(join(home, '.codex/config.toml'), '[plugins."workflowx@official"]\nenabled = true')
    expect((await detect()).status).toBe('uncertain')
    await put(join(home, '.codex/plugins/cache/official/workflowx/1/.codex-plugin/plugin.json'), '{"name":"workflowx","repository":"https://example.org/fork"}')
    expect((await detect()).status).toBe('uncertain')
  })
})
