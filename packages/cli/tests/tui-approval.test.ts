/**
 * Per-action approval through the real runtime policy gate: the model stub
 * emits a `workspace.create` tool call, the runtime raises
 * `approval-requested`, the session resolves it via the injected prompter.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliSession, isSessionValidationError, type ApprovalPrompt } from '../src/session.js'
import { memoryConversationStore } from '../src/conversations.js'
import { arrayLineSource, runRepl } from '../src/repl.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

type StreamFn = ChatTurnPorts['streamTextFn']

function createStub(onText: (calls: number) => string): StreamFn {
  let calls = 0
  return (async () => {
    calls += 1
    if (calls % 2 === 1) {
      return {
        fullStream: (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: `c${calls}`,
            toolName: 'workspace_create',
            args: { workspaceId: 'cli', path: 'created.txt', content: 'hello approval' },
          }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(),
        textStream: (async function* () { })(),
      }
    }
    return { textStream: (async function* () { yield onText(calls) })() }
  }) as unknown as StreamFn
}

async function openSession(dir: string, init: {
  approvalMode?: 'auto-run' | 'per-action'
  onApproval?: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  prompts?: ApprovalPrompt[]
}): Promise<CliSession> {
  const session = await CliSession.create({
    workspace: dir,
    model: 'm',
    apiKey: 'k',
    approvalMode: init.approvalMode,
    store: memoryConversationStore(),
    streamTextFn: createStub(() => 'follow-up text'),
    onApproval: async (prompt, signal) => {
      init.prompts?.push(prompt)
      return init.onApproval ? init.onApproval(prompt, signal) : false
    },
  })
  if (isSessionValidationError(session)) throw new Error(session.message)
  return session
}

describe('approval', () => {
  it('auto-run executes writes without prompting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-approval-auto-'))
    const prompts: ApprovalPrompt[] = []
    const session = await openSession(dir, { prompts })
    const result = await session.sendTurn('create the file')
    expect(result.cancelled).toBe(false)
    expect(prompts).toHaveLength(0)
    expect(existsSync(join(dir, 'created.txt'))).toBe(true)
    expect(readFileSync(join(dir, 'created.txt'), 'utf8')).toContain('hello approval')
    await session.close()
  })

  it('per-action approves on y with a redacted prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-approval-yes-'))
    const prompts: ApprovalPrompt[] = []
    const session = await openSession(dir, {
      approvalMode: 'per-action',
      prompts,
      onApproval: async () => true,
    })
    const result = await session.sendTurn('create the file')
    expect(result.cancelled).toBe(false)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ toolName: 'workspace.create', workspaceId: 'cli' })
    expect(prompts[0].paths?.join(' ')).toContain('created.txt')
    expect(existsSync(join(dir, 'created.txt'))).toBe(true)
    await session.close()
  })

  it('per-action denies on n and the turn still completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-approval-no-'))
    const session = await openSession(dir, { approvalMode: 'per-action', onApproval: async () => false })
    const result = await session.sendTurn('create the file')
    expect(result.cancelled).toBe(false)
    expect(result.text).toContain('follow-up text')
    expect(existsSync(join(dir, 'created.txt'))).toBe(false)
    await session.close()
  })

  it('live-switches modes mid-session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-approval-switch-'))
    const prompts: ApprovalPrompt[] = []
    const session = await openSession(dir, { prompts, onApproval: async () => true })
    await session.sendTurn('first file')
    expect(prompts).toHaveLength(0)
    session.setApprovalMode('per-action')
    expect(session.getApprovalMode()).toBe('per-action')
    await session.sendTurn('second file')
    expect(prompts).toHaveLength(1)
    await session.close()
  })

  it('treats turn abort during approval as deny instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-approval-abort-'))
    const session = await openSession(dir, {
      approvalMode: 'per-action',
      onApproval: async (_prompt, signal) => {
        if (signal.aborted) return false
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return false
      },
    })
    const controller = new AbortController()
    const pending = session.sendTurn('create the file', { onEvent: () => controller.abort() }, controller.signal)
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(existsSync(join(dir, 'created.txt'))).toBe(false)
    await session.close()
  })
})

describe('runRepl approval', () => {
  it('asks y/N in the loop and executes on y', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-approve-'))
    const out: string[] = []
    const err: string[] = []
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: (text) => { err.push(text) },
        env: {} as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        authPath: null,
        lines: arrayLineSource(['/approval per-action', 'create file please', 'y', '/exit']),
        streamTextFn: createStub(() => 'file is ready'),
      },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('approval: per-action')
    expect(out.join('')).toContain('Allow?')
    expect(out.join('')).toContain('workspace.create')
    expect(existsSync(join(dir, 'created.txt'))).toBe(true)
    expect(err.join('')).toBe('')
  })

  it('denies on n and keeps the file absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-repl-deny-'))
    const out: string[] = []
    const code = await runRepl(
      { workspace: dir, model: 'm', apiKey: 'k', plain: true },
      {
        stdout: (text) => { out.push(text) },
        stderr: () => undefined,
        env: {} as NodeJS.ProcessEnv,
        store: memoryConversationStore(),
        configPath: null,
        authPath: null,
        lines: arrayLineSource(['/approval per-action', 'create file please', 'n', '/exit']),
        streamTextFn: createStub(() => 'not created'),
      },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('Allow?')
    expect(existsSync(join(dir, 'created.txt'))).toBe(false)
  })
})
