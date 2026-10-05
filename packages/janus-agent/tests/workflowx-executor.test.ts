import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node'
import { executeWorkflowXTask } from '../src/workflowx-executor.js'
import { runChatTurn } from '../src/orchestrator/chat-turn.js'
import type { ChatTurnPorts, AgentSessionDescriptor } from '../src/ports.js'
vi.mock('../src/orchestrator/chat-turn.js', () => ({ runChatTurn: vi.fn() }))
const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91'
const TASK = '55555555-5555-4333-8333-555555555555'
const URI = `note://${REPO}/${TASK}`
const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wfx-execute-')); roots.push(root)
  await mkdir(join(root, '.agents/notes'), { recursive: true }); await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/file.txt'), 'before')
  await writeFile(join(root, '.agents/harness.json'), JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'Fixture', profile: SUPPORTED_HARNESS_PROFILE }))
  await writeFile(join(root, '.agents/notes/task.md'), [
    '---', 'schema: harness-note/1', `id: ${TASK}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-10-05',
    'work:', '  scope:', `    - repoId: ${REPO}`, "      paths: ['src/']", '  acceptanceRefs:', `    - uri: ${URI}`, '      criterionId: AC-1',
    '  verification:', '    - id: check', '      kind: command', '      required: true', `      repoId: ${REPO}`, '      cwd: .', '      program: node', "      args: ['-e', 'process.exit(0)']",
    '---', '# Test task', '## Scope', 'Edit source.', '## Acceptance criteria', '- [ ] AC-1: source works', '## Verification', 'Run check.',
  ].join('\n'))
  expect(runGit(root, ['init']).ok).toBe(true); expect(runGit(root, ['add', 'src/file.txt']).ok).toBe(true)
  const parent: AgentSessionDescriptor = { sessionId: 'parent', workspaceId: 'w', workspaceRoot: root, status: 'running' }
  const closed: string[] = []; let count = 0
  const ports: ChatTurnPorts = {
    model: { resolve: async () => ({ model: {}, modelId: 'm' }), getMaxTurns: () => 3 },
    sessions: { getSession: () => parent, forkSession: async () => ({ ...parent, sessionId: `child-${++count}` }), closeSession: async id => { closed.push(id) } },
    tools: { registry: { list: () => [] }, executeFunctionCall: vi.fn(async () => ({ status: 'completed', output: { ok: true, exitCode: 0 } }) as never) },
    streamTextFn: async () => ({}),
  }
  const roles: string[] = []; const sessions: string[] = []
  vi.mocked(runChatTurn).mockImplementation(async request => {
    sessions.push(request.workspaceResources![0].agentSessionId)
    expect(request.sourceTag).toBe('harness')
    expect(await request.toolGate!({ name: 'workspace_edit', arguments: { path: '../outside.txt' } })).toMatchObject({ block: true })
    const prompt = request.messages[0].content
    let text = 'implemented'
    if (prompt.startsWith('Implement the pinned')) await writeFile(join(root, 'src/file.txt'), 'after')
    else {
      const shape = JSON.parse(prompt.split('\n').at(-1)!)
      roles.push(shape.review.kind)
      expect(await request.toolGate!({ name: 'workspace_edit', arguments: { path: 'src/file.txt' } })).toMatchObject({ block: true })
      shape.review.verdict = 'approved'; shape.coverage = shape.coverage.map((criterion: object) => ({ ...criterion, checkIds: ['check'] }))
      text = JSON.stringify(shape)
    }
    return { requestId: request.requestId, text, cancelled: false, compacted: false, todos: [], toolTraces: [] }
  })
  return { root, parent, ports, closed, roles, sessions }
}
describe('WorkflowX shared executor adapter', () => {
  it.each(['xdel', 'xflow'] as const)('executes %s through isolated sessions and real verification ports', async mode => {
    const f = await fixture()
    const result = await executeWorkflowXTask({ mode, taskUri: URI, parent: f.parent, ports: f.ports, request: { requestId: 'r', providerId: 'p', messages: [] } })
    expect(result.errors).toEqual([]); expect(result.completed).toBe(true)
    expect(f.roles).toEqual(mode === 'xdel' ? ['self'] : ['self', 'independent'])
    expect(new Set(f.sessions).size).toBe(f.sessions.length)
    expect(f.closed).toHaveLength(f.sessions.length + 1)
    expect(f.ports.tools.executeFunctionCall).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ toolName: 'command.run', input: expect.objectContaining({ program: 'node', background: false }) }) }), 'janus-agent')
  })
  it('refuses missing child capability and aborted requests before execution', async () => {
    const f = await fixture(); const request = { requestId: 'r', providerId: 'p', messages: [] }
    await expect(executeWorkflowXTask({ mode: 'xdel', taskUri: URI, parent: f.parent, ports: { ...f.ports, sessions: { getSession: () => f.parent } }, request })).rejects.toThrow('CAPABILITY_UNAVAILABLE')
    const controller = new AbortController(); controller.abort()
    await expect(executeWorkflowXTask({ mode: 'xflow', taskUri: URI, parent: f.parent, ports: f.ports, request, signal: controller.signal })).rejects.toThrow()
    expect(runChatTurn).not.toHaveBeenCalled()
  })
  it('does not complete on a failed verification command', async () => {
    const f = await fixture()
    vi.mocked(f.ports.tools.executeFunctionCall).mockResolvedValue({ status: 'completed', output: { ok: false, exitCode: 1 } } as never)
    const result = await executeWorkflowXTask({ mode: 'xdel', taskUri: URI, parent: f.parent, ports: f.ports, request: { requestId: 'r', providerId: 'p', messages: [] } })
    expect(result.completed).toBe(false)
  })
})
