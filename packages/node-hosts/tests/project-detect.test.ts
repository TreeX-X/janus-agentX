/**
 * node-hosts project.detect tests: registration, marker detection, bounds.
 * Pure filesystem fixtures under tmp; no network, no git binary needed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRuntime } from '@janus-agent/agent-core'
import { registerProjectDetectTools } from '../src/project-detect.js'
import { registerNodeHostTools } from '../src/index.js'
import { JobManager } from '../src/jobs.js'

async function createHarness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'janus-hosts-detect-'))
  const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => workspaceRoot })
  registerProjectDetectTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'cli', workspaceRoot, approvalMode: 'auto-run' })
  const call = (toolName: string, input: Record<string, unknown>) =>
    runtime.executeTool({ sessionId: session.id, call: { toolName, input } }, 'test')
  return { call, workspaceRoot }
}

describe('node-hosts project.detect', () => {
  it('ships with the shared host toolset', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'janus-hosts-detect-all-'))
    const runtime = createAgentRuntime({ resolveWorkspaceRoot: async () => workspaceRoot })
    registerNodeHostTools(runtime.registry, new JobManager())
    expect(runtime.registry.get('project.detect')).toBeTruthy()
  })

  it('detects node and python projects with names and scripts', async () => {
    const { call, workspaceRoot } = await createHarness()
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite', build: 'tsc' } }))
    mkdirSync(join(workspaceRoot, 'api'))
    writeFileSync(join(workspaceRoot, 'api', 'pyproject.toml'), '[project]\nname = "api"\n')
    const result = await call('project.detect', { workspaceId: 'cli' })
    expect(result.status).toBe('completed')
    const output = result.output as { projects: Array<{ path: string; kinds: string[]; name?: string; scripts?: string[] }> }
    const root = output.projects.find((project) => project.path === '.')
    expect(root?.kinds).toContain('node')
    expect(root?.name).toBe('web')
    expect(root?.scripts).toEqual(['dev', 'build'])
    const api = output.projects.find((project) => project.path === 'api')
    expect(api?.kinds).toContain('python')
    expect(api?.name).toBe('api')
  })

  it('respects depth budgets and skips build output', async () => {
    const { call, workspaceRoot } = await createHarness()
    mkdirSync(join(workspaceRoot, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep' }))
    mkdirSync(join(workspaceRoot, 'deep', 'nested'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'deep', 'nested', 'go.mod'), 'module deep/nested\n')
    const shallow = await call('project.detect', { workspaceId: 'cli', depth: 0 })
    const shallowProjects = (shallow.output as { projects: unknown[] }).projects
    expect(shallowProjects).toEqual([])
    const deep = await call('project.detect', { workspaceId: 'cli', depth: 2 })
    const names = ((deep.output as { projects: Array<{ path: string }> }).projects).map((project) => project.path)
    expect(names).toContain('deep/nested')
    expect(names.some((path) => path.includes('node_modules'))).toBe(false)
  })

  it('fails closed on workspace mismatch and non-directories', async () => {
    const { call, workspaceRoot } = await createHarness()
    expect((await call('project.detect', { workspaceId: 'ghost' })).status).toBe('failed')
    writeFileSync(join(workspaceRoot, 'file.txt'), 'x')
    expect((await call('project.detect', { workspaceId: 'cli', path: 'file.txt' })).status).toBe('failed')
    expect((await call('project.detect', { workspaceId: 'cli', path: '../escape' })).status).toBe('failed')
  })
})
