import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node'
import { CliSession, isSessionValidationError } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
it.each(['xdel', 'xflow'])('runs /%s through real CLI child sessions, preserves approvals and returns formal evidence', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'cli-workflowx-')); roots.push(root)
  const repo = '8fa19f17-c717-43a8-93a7-810a5e0cbc91'; const task = '55555555-5555-4333-8333-555555555555'; const uri = `note://${repo}/${task}`
  await mkdir(join(root, '.agents/notes'), { recursive: true }); await mkdir(join(root, 'src'))
  await writeFile(join(root, '.agents/harness.json'), JSON.stringify({ schemaVersion: 1, repoId: repo, name: 'Fixture', profile: SUPPORTED_HARNESS_PROFILE }))
  await writeFile(join(root, '.agents/notes/task.md'), [
    '---', 'schema: harness-note/1', `id: ${task}`, 'kind: task', 'lifecycle: accepted', 'created: 2026-10-05',
    'work:', '  scope:', `    - repoId: ${repo}`, "      paths: ['src/']", '  acceptanceRefs:', `    - uri: ${uri}`, '      criterionId: AC-1',
    '  verification:', '    - id: check', '      kind: command', '      required: true', `      repoId: ${repo}`, '      cwd: .', '      program: node', "      args: ['-e', 'process.exit(0)']",
    '---', '# Test task', '## Scope', 'Create source.', '## Acceptance criteria', '- [ ] AC-1: source works', '## Verification', 'Run check.',
  ].join('\n'))
  expect(runGit(root, ['init']).ok).toBe(true)
  let executed = false; let created = false; const approvals: string[] = []
  const text = (content: string) => ({ textStream: (async function* () { yield content })() })
  const call = (toolName: string, args: object) => ({ textStream: (async function* () {})(), fullStream: (async function* () {
    yield { type: 'tool-call', toolCallId: toolName, toolName, args }; yield { type: 'finish', finishReason: 'tool-calls' }
  })() })
  const session = await CliSession.create({ workspace: root, model: 'm', apiKey: 'key', approvalMode: 'per-action', env: {}, store: memoryConversationStore(),
    onApproval: async request => { approvals.push(request.toolName); return true },
    streamTextFn: async options => {
      const prompt = String([...options.messages].reverse().find(message => message.role === 'user')?.content ?? '')
      if (prompt.startsWith('Implement the pinned')) {
        if (!created) { created = true; return call('workspace_create', { path: 'src/new.txt', content: 'implemented' }) }
        return text('implemented')
      }
      if (prompt.startsWith('Implementor self-review') || prompt.startsWith('Independent evaluation')) {
        const shape = JSON.parse(prompt.split('\n').at(-1)!)
        shape.review.verdict = 'approved'; shape.coverage = shape.coverage.map((criterion: object) => ({ ...criterion, checkIds: ['check'] }))
        return text(JSON.stringify(shape))
      }
      if (!executed) { executed = true; return call('workflow_execute', { taskUri: uri }) }
      return text('verified; commit pending')
    },
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  try {
    expect((await session.sendTurn(`/${mode}`)).text).toBe(`WorkflowX: ${mode}`)
    const result = await session.sendTurn('implement the accepted task')
    expect(await readFile(join(root, 'src/new.txt'), 'utf8')).toBe('implemented')
    expect(approvals).toEqual(expect.arrayContaining(['workspace.create', 'command.run']))
    const trace = result.toolTraces.find(trace => trace.toolName === 'workflow_execute')!
    expect(trace.status, trace.summary).toBe('completed')
    const receipt = JSON.parse(trace.summary!)
    expect(receipt.completed).toBe(true)
    expect(receipt.closeout?.satisfied).toBe(false)
  } finally { await session.close() }
}, 20000)
