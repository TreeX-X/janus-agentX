import { describe, expect, it } from 'vitest'
import { ChatSessionRuntime } from '../src/main/llm/chat-session-runtime'
import { buildChatSystemPrompt } from '../src/main/llm/system-prompt-builder'
import type { ToolManifest } from '../src/main/agent/runtime/tool-manifest'
import type { ToolResult } from '../src/shared/ipc/agent-runtime'

function toolResult(overrides: Partial<ToolResult>): ToolResult {
  return {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    correlationId: 'call-1',
    toolName: 'workspace.read',
    status: 'completed',
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: '2026-08-27T00:00:00.000Z',
    durationMs: 0,
    summary: 'completed',
    ...overrides,
  }
}

describe('ChatSessionRuntime', () => {
  it('keeps the newest complete context suffix when the history exceeds its budget', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old request '.repeat(160) },
      { role: 'assistant', content: 'old answer '.repeat(80) },
      { role: 'user', content: 'current request '.repeat(40) },
    ], { model: { contextWindow: 800, maxOutputTokens: 100 } })

    expect(context.map((message) => message.role)).toEqual(['system', 'user'])
    expect(context.at(-1)?.content).toContain('current request')
    expect(context.some((message) => message.content.includes('old request'))).toBe(false)
  })

  it('preserves chronological order after selecting the newest context suffix', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old request '.repeat(160) },
      { role: 'assistant', content: 'old answer '.repeat(80) },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
      { role: 'user', content: 'current request' },
    ], { model: { contextWindow: 800, maxOutputTokens: 100 } })

    expect(context.map((message) => message.content)).toEqual([
      'policy',
      'new request',
      'new answer',
      'current request',
    ])
  })

  it('keeps a tool call and its complete result together when they fit', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace_read', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'call-1', toolName: 'workspace_read', content: JSON.stringify({ content: 'x'.repeat(8_000), path: 'a.ts' }) },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })

    const assistant = context.find((message) => message.role === 'assistant')
    const tool = context.find((message) => message.role === 'tool')
    expect(assistant?.toolCalls?.[0]?.id).toBe('call-1')
    expect(tool?.toolCallId).toBe('call-1')
    expect(JSON.parse(tool!.content).content).toBe('x'.repeat(8_000))
  })

  it('preserves a fresh read beyond the former 2000 character cut', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace_read', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'call-1', toolName: 'workspace_read', content: JSON.stringify({ content: 'y'.repeat(3_000), path: 'a.ts' }) },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })

    const tool = context.find((message) => message.role === 'tool')
    expect(JSON.parse(tool!.content).content).toBe('y'.repeat(3_000))
  })

  it('prunes stale tool outputs to digests while retaining the calls', () => {
    const runtime = new ChatSessionRuntime()
    const oldUnit = (id: string) => ([
      { role: 'assistant' as const, content: '', toolCalls: [{ id, name: 'workspace_search', arguments: { query: 'old' } }] },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_search', content: JSON.stringify({ workspaceId: 'w', query: 'old', path: '', matches: [{ path: 'old.ts', line: 1 }] }) },
    ])
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'first dig' },
      ...oldUnit('call-old'),
      { role: 'user' as const, content: 'second dig' },
      ...oldUnit('call-mid'),
      { role: 'user' as const, content: `current request ${'z'.repeat(30_000)}` },
    ]
    const context = runtime.buildContext(messages, {
      model: { contextWindow: 200_000, maxOutputTokens: 100 },
      pruneKeepTokens: 4_000,
    })

    const pruned = context.find((message) => message.role === 'tool' && message.toolCallId === 'call-old')
    expect(pruned?.content).toContain('"pruned":true')
    expect(pruned?.content).toContain('workspace_search')
    const prunedCalls = context.filter((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'call-old'))
    expect(prunedCalls).toHaveLength(1)
    const recent = context.find((message) => message.role === 'user' && message.content.includes('current request'))
    expect(recent).toBeDefined()
  })

  // Note: graded prune — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
  it('prunes old search outputs even within budget but keeps old reads verbatim', () => {
    const runtime = new ChatSessionRuntime()
    const searchUnit = (id: string, query: string) => ([
      { role: 'assistant' as const, content: '', toolCalls: [{ id, name: 'workspace_search', arguments: { query } }] },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_search', content: `Found 1 match for "${query}"\n\na.ts:\n Line 1: ${query}` },
    ])
    const readUnit = (id: string) => ([
      { role: 'assistant' as const, content: '', toolCalls: [{ id, name: 'workspace_read', arguments: { path: 'a.ts' } }] },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_read', content: '<path>a.ts</path> lines 1-10/100\n<content>\n1: hello\n</content>' },
    ])
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'first' },
      ...searchUnit('call-s1', 'alpha'),
      { role: 'user' as const, content: 'second' },
      ...searchUnit('call-s2', 'beta'),
      { role: 'user' as const, content: 'third' },
      ...searchUnit('call-s3', 'gamma'),
      { role: 'user' as const, content: 'fourth' },
      ...readUnit('call-r1'),
      { role: 'user' as const, content: 'current request' },
    ]
    const context = runtime.buildContext(messages, {
      model: { contextWindow: 200_000, maxOutputTokens: 100 },
    })
    const oldSearch = context.find((message) => message.role === 'tool' && message.toolCallId === 'call-s1')
    expect(oldSearch?.content).toContain('"pruned":true')
    const oldRead = context.find((message) => message.role === 'tool' && message.toolCallId === 'call-r1')
    expect(oldRead?.content).not.toContain('"pruned":true')
    expect(oldRead?.content).toContain('hello')
  })

  // Note: graded read prune — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
  it('keeps the newest three reads verbatim and digests older ones within budget', () => {
    const runtime = new ChatSessionRuntime()
    const readUnit = (id: string, marker: string) => ([
      { role: 'assistant' as const, content: '', toolCalls: [{ id, name: 'workspace_read', arguments: { path: `${marker}.ts` } }] },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_read', content: `<path>${marker}.ts</path> lines 1-10/100\n<content>\n1: ${marker}\n</content>` },
    ])
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'first' },
      ...readUnit('call-r1', 'alpha'),
      { role: 'user' as const, content: 'second' },
      ...readUnit('call-r2', 'beta'),
      { role: 'user' as const, content: 'third' },
      ...readUnit('call-r3', 'gamma'),
      { role: 'user' as const, content: 'fourth' },
      ...readUnit('call-r4', 'delta'),
      { role: 'user' as const, content: 'current request' },
    ]
    const context = runtime.buildContext(messages, {
      model: { contextWindow: 200_000, maxOutputTokens: 100 },
    })
    expect(context.find((m) => m.role === 'tool' && m.toolCallId === 'call-r1')?.content).toContain('"pruned":true')
    for (const id of ['call-r2', 'call-r3', 'call-r4']) {
      const tool = context.find((m) => m.role === 'tool' && m.toolCallId === id)
      expect(tool?.content).not.toContain('"pruned":true')
    }
  })

  it('leaves mixed read-plus-edit units on the byte tail instead of the read cap', () => {
    const runtime = new ChatSessionRuntime()
    const mixedUnit = (id: string) => ([
      { role: 'assistant' as const, content: '', toolCalls: [
        { id: `${id}-read`, name: 'workspace_read', arguments: { path: 'a.ts' } },
        { id, name: 'workspace_edit', arguments: { path: 'a.ts' } },
      ] },
      { role: 'tool' as const, toolCallId: `${id}-read`, toolName: 'workspace_read', content: '<path>a.ts</path> lines 1-2/10\n<content>\n1: x\n</content>' },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_edit', content: `Edited a.ts sha=${'d'.repeat(64)}` },
    ])
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'fix' },
      ...mixedUnit('call-m1'),
      { role: 'user' as const, content: 'current request' },
    ]
    const context = runtime.buildContext(messages, {
      model: { contextWindow: 200_000, maxOutputTokens: 100 },
    })
    expect(context.find((m) => m.role === 'tool' && m.toolCallId === 'call-m1-read')?.content).toContain('1: x')
  })

  // Note: tool-loop chatter cap — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
  it('drops old assistant chatter around tool calls but keeps the calls and pure answers', () => {
    const runtime = new ChatSessionRuntime()
    const chatterUnit = (id: string, text: string) => ([
      { role: 'assistant' as const, content: text, toolCalls: [{ id, name: 'workspace_search', arguments: { query: text } }] },
      { role: 'tool' as const, toolCallId: id, toolName: 'workspace_search', content: `Found 1 match for "${text}"\n\na.ts:\n Line 1: ${text}` },
    ])
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'first' },
      ...chatterUnit('call-c1', 'old chatter'),
      { role: 'user' as const, content: 'second' },
      ...chatterUnit('call-c2', 'mid chatter'),
      { role: 'user' as const, content: 'third' },
      ...chatterUnit('call-c3', 'new chatter'),
      { role: 'assistant' as const, content: 'an old conclusion without calls' },
      { role: 'user' as const, content: 'current request' },
    ]
    const context = runtime.buildContext(messages, {
      model: { contextWindow: 200_000, maxOutputTokens: 100 },
    })
    const oldChatter = context.find((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'call-c1'))
    expect(oldChatter?.content).toBe('')
    expect(oldChatter?.toolCalls).toHaveLength(1)
    // Pure-text answers are never chatter-capped.
    expect(context.some((m) => m.role === 'assistant' && m.content === 'an old conclusion without calls')).toBe(true)
  })

  it('keeps short sessions fully verbatim without pruning', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'search' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace_search', arguments: { query: 'q' } }] },
      { role: 'tool', toolCallId: 'call-1', toolName: 'workspace_search', content: JSON.stringify({ workspaceId: 'w', query: 'q', path: '', matches: [{ path: 'a.ts', line: 2 }] }) },
    ], { model: { contextWindow: 200_000, maxOutputTokens: 100 } })

    const tool = context.find((message) => message.role === 'tool')
    expect(tool?.content).not.toContain('"pruned":true')
    expect(tool?.content).toContain('a.ts')
  })

  it('injects only read evidence and invalidates it after a file mutation', () => {
    const runtime = new ChatSessionRuntime()
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', sha256: 'abc', size: 20, content: 'const value = 1' },
    }))
    const beforeEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'change a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    expect(beforeEdit.some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(true)

    runtime.recordToolResult(toolResult({
      toolName: 'workspace.edit',
      output: { workspaceId: 'workspace-1', changedPaths: ['a.ts'] },
    }))
    const afterEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'change a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    expect(afterEdit.some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(false)
  })

  it('invalidates loaded evidence after a workspace.delete', () => {
    const runtime = new ChatSessionRuntime()
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', sha256: 'abc', size: 20, content: 'const value = 1' },
    }))
    runtime.recordToolResult(toolResult({
      toolName: 'workspace.delete',
      output: { workspaceId: 'workspace-1', path: 'a.ts', kind: 'file', bytes: 20, changedPaths: ['a.ts'] },
    }))
    const afterDelete = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'inspect a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    expect(afterDelete.some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(false)
  })

  it('keeps separately loaded file pages and invalidates all pages after an edit', () => {
    const runtime = new ChatSessionRuntime()
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', offset: 1, lineEnd: 1, totalLines: 5, nextOffset: 2, bytes: 5, sha256: 'abc', size: 20, truncated: true, content: 'first' },
    }))
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', offset: 2, lineEnd: 2, totalLines: 5, nextOffset: 3, bytes: 6, sha256: 'abc', size: 20, truncated: true, content: 'second' },
    }))

    const beforeEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'inspect a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    const evidence = beforeEdit.filter((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))
    expect(evidence).toHaveLength(1)
    expect(evidence[0].content).toContain('lines=2-2/5')
    expect(evidence[0].content).toContain('offset=3')

    runtime.recordToolResult(toolResult({
      toolName: 'workspace.edit',
      output: { workspaceId: 'workspace-1', changedPaths: ['a.ts'] },
    }))
    expect(runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'inspect a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
      .some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(false)
  })

  it('keeps a deterministic handoff with exact digests when old tool turns are pruned', () => {
    const runtime = new ChatSessionRuntime()
    const matches = Array.from({ length: 30 }, (_, index) => ({ path: `src/file${index}.tsx`, line: index + 1, text: 'flip effect '.repeat(6) }))
    const searchResult = JSON.stringify({
      workspaceId: 'workspace-1', query: 'flip', path: '',
      matches, truncated: true,
    })
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old exploration' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-old', name: 'workspace_search', arguments: { query: 'flip' } }] },
      { role: 'tool', toolCallId: 'call-old', toolName: 'workspace_search', content: searchResult },
      { role: 'user', content: 'current request '.repeat(40) },
    ], { model: { contextWindow: 1000, maxOutputTokens: 100 } })

    const handoff = context.find((message) => message.content.includes('was pruned') || message.content.includes('\"pruned\":true'))
    expect(handoff?.content).toContain('flip')
    expect(handoff?.content).toContain('src/file0.tsx#L1')
    expect(context.at(-1)?.content).toContain('current request')
  })
})

describe('context efficiency regressions', () => {
  it('keeps all 200 visible lines, correct continuation, and only one copy of the body', () => {
    const runtime = new ChatSessionRuntime()
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${'x'.repeat(65)}`).join('\n')
    const output = { workspaceId: 'w', path: 'a.ts', sha256: 'abc123', content, offset: 1, lineStart: 1, lineEnd: 200, nextOffset: 201, totalLines: 400, truncated: true }
    runtime.recordToolResult(toolResult({ output }))
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' }, { role: 'user', content: 'fix line 150' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'workspace_read', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'r', toolName: 'workspace_read', content: JSON.stringify(output) },
    ], { model: { contextWindow: 32000, maxOutputTokens: 2000 } })
    const result = JSON.parse(context.find((message) => message.role === 'tool')!.content)
    expect(result.content).toBe(content)
    expect(result.nextOffset).toBe(201)
    expect(context.filter((message) => message.content.includes('line 150:'))).toHaveLength(1)
    expect(context.filter((message) => message.role === 'system')).toHaveLength(1)
  })

  it('preserves search JSON and coverage metadata beyond 2000 characters', () => {
    const output = { matches: Array.from({ length: 30 }, (_, i) => ({ path: `src/${i}.ts`, line: 1, text: 'match '.repeat(30) })), scannedFiles: 99, truncated: true }
    const context = new ChatSessionRuntime().buildContext([
      { role: 'user', content: 'find match' },
      { role: 'assistant', content: '', toolCalls: [{ id: 's', name: 'workspace_search', arguments: { query: 'match' } }] },
      { role: 'tool', toolCallId: 's', toolName: 'workspace_search', content: JSON.stringify(output) },
    ])
    expect(JSON.parse(context.at(-1)!.content)).toEqual(output)
  })

  it('prunes old bodies before paying for an LLM summary', async () => {
    const runtime = new ChatSessionRuntime()
    let summaryCalls = 0
    const messages = [
      { role: 'user' as const, content: 'old task' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'r', name: 'workspace_read', arguments: { path: 'old.ts' } }] },
      { role: 'tool' as const, toolName: 'workspace_read', toolCallId: 'r', content: JSON.stringify({ path: 'old.ts', content: 'x'.repeat(20000) }) },
      { role: 'user' as const, content: 'current task' },
    ]
    await runtime.maybeCompact(messages, { model: { contextWindow: 4000, maxOutputTokens: 100 } }, async () => { summaryCalls++; return '' })
    expect(summaryCalls).toBe(0)
    expect(runtime.buildContext(messages, { model: { contextWindow: 4000, maxOutputTokens: 100 } }).some((message) => message.content.includes('"pruned":true'))).toBe(true)
  })

  it('reserves tools and counts large edit arguments rather than silently dropping the user', () => {
    const runtime = new ChatSessionRuntime()
    expect(() => runtime.buildContext([{ role: 'user', content: 'current' }], { model: { contextWindow: 1000, maxOutputTokens: 100 }, toolTokens: 900 })).toThrow('SYSTEM_CONTEXT')
    expect(() => runtime.buildContext([
      { role: 'user', content: 'current' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'edit', name: 'workspace_edit', arguments: { content: 'x'.repeat(10000) } }] },
      { role: 'tool', content: 'ok', toolCallId: 'edit' },
    ], { model: { contextWindow: 1000, maxOutputTokens: 100 } })).toThrow('CURRENT_CONTEXT')
  })
})

describe('SystemPromptBuilder', () => {
  it('derives the minimal contract from active tool manifests without exposing workspace roots', () => {
    const toolManifests: ToolManifest[] = [
      {
        canonicalName: 'workspace.read', providerName: 'workspace_read', version: 1,
        description: 'Read a UTF-8 text file inside the current workspace', actionRisk: 'read',
        inputSchema: { type: 'object' },
      },
      {
        canonicalName: 'workspace.edit', providerName: 'workspace_edit', version: 1,
        description: 'Apply bounded exact replacements or one unified diff', actionRisk: 'write',
        inputSchema: { type: 'object' },
      },
    ]
    const prompt = buildChatSystemPrompt({
      resources: new Map([['workspace-1', { workspaceName: 'Project', workspaceRoot: 'C:/project' }]]),
      toolManifests,
    })

    expect(prompt).toContain('You are JanusX, a workspace agent')
    expect(prompt).toContain('not the filesystem, shell, or approval system')
    expect(prompt).not.toContain('System Contract v2')
    expect(prompt).toContain('workspace_read [read]')
    expect(prompt).toContain('workspace_edit [write]')
    expect(prompt).not.toContain('command_run')
    expect(prompt).toContain('workspaceId=workspace-1')
    expect(prompt).not.toContain('C:/project')
    expect(prompt).toContain('Do not preload or vectorize the workspace')
    expect(prompt).toContain('Do not retry a denied action')
    expect(prompt).toContain('Prefer search over walking the tree')
    expect(prompt).toContain('prefer background execution')
    expect(prompt).toContain("Respond in the user's language")
    expect(prompt).toContain('prefer workspace_delete over shell rm')
    expect(prompt).toContain('recursive:true')
  })

  it('does not claim tool access when a workspace has no active manifest', () => {
    const prompt = buildChatSystemPrompt({
      resources: new Map([['workspace-1', { workspaceName: 'Project' }]]),
      toolManifests: [],
    })

    expect(prompt).toContain('No workspace tools are enabled for this request.')
    expect(prompt).not.toContain('Enabled tools:')
  })

  it('lists tools in sorted provider-name order regardless of registry order', () => {
    const manifest = (providerName: string): ToolManifest => ({
      canonicalName: providerName.replace(/_/g, '.'), providerName, version: 1,
      description: `desc ${providerName}`, actionRisk: 'read',
      inputSchema: { type: 'object' },
    })
    const prompt = buildChatSystemPrompt({
      resources: new Map([['workspace-1', { workspaceName: 'Project' }]]),
      toolManifests: [manifest('workspace_search'), manifest('command_run'), manifest('workspace_read')],
    })

    const lines = prompt.split('\n').filter((line) => line.endsWith('[read]'))
    expect(lines).toEqual([
      '- command_run [read]',
      '- workspace_read [read]',
      '- workspace_search [read]',
    ])
  })
})
