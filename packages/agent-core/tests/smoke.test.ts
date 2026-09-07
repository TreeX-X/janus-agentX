/**
 * Phase1 smoke: agent-core runs standalone (no Electron, no LLM service).
 * Covers the port seams: injected streamTextFn, sink-based registry,
 * file audit with explicit root, fail-closed runtime without resolver.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runJanusAgentLoop } from '../src/main/agent/loop/janus-agent-loop'
import { createVercelStream } from '../src/main/agent/loop/vercel-stream-adapter'
import { ToolCallAccumulator } from '../src/main/agent/stream/tool-call-accumulator'
import { createParser } from '../src/main/agent/parsers/index'
import { evaluateWorkspaceActionPolicy } from '../src/main/agent/runtime/policy-gate'
import { MemoryPolicyAuditStore, FilePolicyAuditStore } from '../src/main/agent/runtime/policy-audit-store'
import { WorkspaceAgentRuntime, createAgentRuntime } from '../src/main/agent/runtime/runtime'
import { SubAgentRunRegistry } from '../src/main/agent/subagent-run-registry'

describe('loop with injected stream', () => {
  it('completes a text-only turn without any host service', async () => {
    const events: string[] = []
    const messages = await runJanusAgentLoop(
      [{ role: 'user', content: 'hi' }],
      {
        tools: [],
        stream: async (_msgs, _signal, emit) => {
          emit({ type: 'message_update', delta: 'hello' })
          return { message: { role: 'assistant', content: 'hello' } }
        },
        maxTurns: 2,
        onEvent: (e) => { events.push(e.type) },
      },
    )
    expect(messages.at(-1)?.content).toBe('hello')
    expect(events).toContain('agent_start')
    expect(events).toContain('agent_end')
  })

  it('createVercelStream requires an injected streamTextFn and maps text deltas', async () => {
    const seen: string[] = []
    const stream = createVercelStream({
      model: { id: 'stub' },
      streamTextFn: async () => ({
        textStream: (async function* () { yield 'a'; yield 'b' })(),
      }),
    })
    const result = await stream(
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      (e) => { if (e.type === 'message_update') seen.push(e.delta) },
    )
    expect(result.message.content).toBe('ab')
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('stream accumulator and parsers', () => {
  it('accumulates a tool call and validates unknown tools', () => {
    const acc = new ToolCallAccumulator({ validate: () => 'Unknown tool: nope' })
    expect(acc.start('c1', 'nope')).toBe(true)
    const resolution = acc.complete({ callId: 'c1', name: 'nope', arguments: {} })
    expect(resolution.status).toBe('invalid')
  })

  it('creates one parser per engine', () => {
    for (const engine of ['claude', 'codex', 'opencode'] as const) {
      expect(createParser(engine).parseLine('{}')).toEqual([])
    }
  })
})

describe('policy and audit stores', () => {
  it('policy gate never allows blind writes; path guard rejects traversal', async () => {
    const decision = evaluateWorkspaceActionPolicy({ actionRisk: 'write', relativePath: '../evil.txt' })
    expect(decision.outcome).not.toBe('allow')
    const { resolveWorkspaceTarget } = await import('../src/main/agent/runtime/path-guard')
    await expect(resolveWorkspaceTarget(tmpdir(), '../evil.txt')).rejects.toThrow()
  })

  it('memory audit store round-trips', async () => {
    const store = new MemoryPolicyAuditStore()
    await store.record({
      workspaceId: 'w', sessionId: 's', correlationId: 'c',
      toolName: 'workspace.read', toolInput: {},
      decision: { outcome: 'allow' },
    } as never)
    expect((await store.query({ workspaceId: 'w' })).length).toBe(1)
  })

  it('file audit store writes JSONL under the given root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-core-audit-'))
    const store = new FilePolicyAuditStore(root)
    await store.record({
      workspaceId: 'w', sessionId: 's', correlationId: 'c',
      toolName: 'workspace.read', toolInput: {},
      decision: { outcome: 'allow' },
    } as never)
    const line = readFileSync(join(root, 'workspace-policy.jsonl'), 'utf8')
    expect(line).toContain('"workspaceId":"w"')
  })
})

describe('runtime and run registry without Electron', () => {
  it('createSession fails closed without a workspace resolver', async () => {
    const runtime = createAgentRuntime()
    await expect(runtime.createSession({ workspaceId: 'w', workspaceRoot: tmpdir() })).rejects.toThrow()
    expect(runtime).toBeInstanceOf(WorkspaceAgentRuntime)
  })

  it('registry emits through the injected sink', () => {
    const registry = new SubAgentRunRegistry()
    const received: Array<{ channel: string; payload: unknown }> = []
    registry.setEventSink((channel, payload) => { received.push({ channel, payload }) })
    const run = registry.createRun({ id: 'r1', status: 'running' } as never)
    expect(run.id).toBe('r1')
    expect(received.length).toBeGreaterThan(0)
    registry.setEventSink(null)
    registry.finishRun('r1', 'done')
    expect(registry.getRun('r1')?.status).toBe('done')
  })
})
