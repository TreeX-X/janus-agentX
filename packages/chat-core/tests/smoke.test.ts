/**
 * chat-core smoke: pure helpers behave exactly like the JanusX shell.
 * Pins the extraction against behaviour drift (Phase0 contract).
 */
import { describe, expect, it } from 'vitest'
import { toChatAgentEvent } from '../src/main/llm/chat-agent-events'
import { buildChatSystemPrompt } from '../src/main/llm/system-prompt-builder'
import { ChatSessionRuntime } from '../src/main/llm/chat-session-runtime'
import {
  emptyResponseFeedback,
  hasExplicitWorkspaceMutationIntent,
  injectKnowledgeContext,
  prepareJanusChatRecall,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
} from '../src/main/llm/chat-pure'

describe('mutation intent', () => {
  it('detects explicit edit requests and read-only guards', () => {
    expect(hasExplicitWorkspaceMutationIntent('帮我修改这个文件')).toBe(true)
    expect(hasExplicitWorkspaceMutationIntent('please fix the bug')).toBe(true)
    expect(hasExplicitWorkspaceMutationIntent('只查看，不要修改')).toBe(false)
    expect(hasExplicitWorkspaceMutationIntent('read-only analysis')).toBe(false)
    expect(hasExplicitWorkspaceMutationIntent('')).toBe(false)
  })
})

describe('tool traces', () => {
  it('compresses a result into a replayable trace line', () => {
    const entry = toolTraceEntryFromResult({
      toolName: 'workspace.read', workspaceId: 'w', status: 'completed',
      summary: 'ok', output: { path: 'a.ts', sha256: 'abc' },
    } as never, 't1')
    expect(entry.toolName).toBe('workspace.read')
    expect(entry.summary).toContain('a.ts')
    expect(entry.turnId).toBe('t1')
  })

  it('renders trace history as a system message', () => {
    const msg = toolTraceHistoryMessage([{
      toolName: 'workspace.read', workspaceId: 'w', status: 'completed', summary: 'a.ts',
    }])
    expect(msg?.role).toBe('system')
    expect(msg?.content).toContain('workspace.read[w]')
    expect(toolTraceHistoryMessage([])).toBeNull()
  })

  it('falls back with a user-facing message when the model goes silent', () => {
    expect(emptyResponseFeedback([], false)).toContain('请重试')
  })
})

describe('knowledge injection and recall', () => {
  it('injects untrusted context before the first conversation message', () => {
    const out = injectKnowledgeContext(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
      'CONTEXT',
    )
    expect(out.length).toBe(3)
    expect(out[1].content).toContain('untrusted')
    expect(out[1].content).toContain('CONTEXT')
  })

  it('prepareJanusChatRecall uses the injected search port', async () => {
    const { messages, trace } = await prepareJanusChatRecall({
      requestId: 'r1',
      messages: [{ role: 'user', content: 'hello' }],
      workspaceId: 'w', workspacePath: '/tmp/w',
      search: async () => ({
        items: [], eligibleCount: 0, truncated: false,
        maxItems: 5, maxChars: 3000, compactContext: 'CTX',
      }) as never,
    })
    expect(trace.status).toBe('empty')
    expect(messages.some((m) => m.content.includes('CTX'))).toBe(true)
  })
})

describe('events, prompt, session budget', () => {
  it('maps stream events to redacted chat events', () => {
    const e = toChatAgentEvent({ type: 'text_delta', requestId: 'r', delta: 'hi' })
    expect(e).toEqual({ type: 'text_delta', requestId: 'r', delta: 'hi' })
    const tool = toChatAgentEvent({
      type: 'tool_call_ready', requestId: 'r',
      call: { id: 'c', name: 'workspace.read', arguments: { token: 'x', path: 'a' } },
    })
    expect(tool).toMatchObject({ type: 'tool_call_ready', argumentKeys: ['redacted', 'path'] })
  })

  it('builds a minimal system prompt with and without tools', () => {
    const empty = buildChatSystemPrompt({ resources: new Map(), toolManifests: [] })
    expect(empty).toContain('No workspace tools are enabled')
    const full = buildChatSystemPrompt({
      resources: new Map([['w', { workspaceName: 'demo' }]]),
      toolManifests: [{ providerName: 'workspace_read', actionRisk: 'read', description: 'read it' } as never],
    })
    expect(full).toContain('workspaceId=w')
    expect(full).toContain('workspace_read [read]')
  })

  it('session budget keeps the current turn and throws only when it cannot', () => {
    const session = new ChatSessionRuntime()
    const out = session.buildContext(
      [{ role: 'user', content: 'hi' }],
      { model: { contextWindow: 16384 } },
    )
    expect(out.length).toBe(1)
    expect(() => session.buildContext(
      [{ role: 'system', content: 'x'.repeat(100_000) }],
      { model: { contextWindow: 1000 } },
    )).toThrow('SYSTEM_CONTEXT_EXCEEDS_BUDGET')
  })
})
