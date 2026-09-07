#!/usr/bin/env node
/**
 * @file janus CLI entry. Pure Node (no Electron, no subprocess runner).
 * Runs the janus-agent dialogue/tool-call loop (`runChatTurn`) against one
 * workspace directory, with a local `WorkspaceAgentRuntime` as the tool
 * host and an OpenAI-compatible model transport. Testable runChat()
 * sits behind a process.argv[1] guard so tests import without side effects.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { streamText } from 'ai'
import {
  createAgentRuntime,
  createToolManifests,
  registerWorkspaceTools,
} from '@janus-agent/agent-core'
import { runChatTurn } from '@janus-agent/janus-agent'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import { createChatModel } from './model.js'
import { helpText, parseArgs } from './args.js'
import type { ChatOptions } from './args.js'

const CLI_WORKSPACE_ID = 'cli'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MAX_TURNS = 40

export interface ChatRunIO {
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  env?: NodeJS.ProcessEnv
  onSigint?: (handler: () => void) => void
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export async function runChat(options: ChatOptions, io: ChatRunIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line))
  const stderr = io.stderr ?? ((line: string) => console.error(line))
  const env = io.env ?? process.env

  const modelId = options.model ?? env.JANUS_MODEL
  const baseURL = options.baseUrl ?? env.JANUS_BASE_URL ?? DEFAULT_BASE_URL
  const apiKey = options.apiKey ?? env.JANUS_API_KEY
  if (!modelId) {
    stderr('janus: missing model. Pass --model <id> or set JANUS_MODEL.')
    return 2
  }
  if (!apiKey) {
    stderr('janus: missing API key. Pass --api-key <key> or set JANUS_API_KEY.')
    return 2
  }

  const workspaceRoot = resolve(options.workspace)
  try {
    if (!statSync(workspaceRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    stderr(`janus: workspace is not a directory: ${options.workspace}`)
    return 2
  }

  const runtime = createAgentRuntime({
    resolveWorkspaceRoot: async (id) => (id === CLI_WORKSPACE_ID ? workspaceRoot : null),
  })
  registerWorkspaceTools(runtime.registry)
  let sessionId: string
  try {
    const session = await runtime.createSession({
      workspaceId: CLI_WORKSPACE_ID,
      workspaceRoot,
      approvalMode: 'auto-run',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
    sessionId = session.id
  } catch (error) {
    stderr(`janus: failed to open workspace session: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const model = createChatModel({ baseURL, apiKey, modelId })
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  type StreamResult = Awaited<ReturnType<ChatTurnPorts['streamTextFn']>>
  const streamTextFn: ChatTurnPorts['streamTextFn'] = io.streamTextFn
    ?? ((opts) => streamText(opts as Parameters<typeof streamText>[0]) as unknown as Promise<StreamResult>)
  const ports: ChatTurnPorts = {
    model: {
      resolve: async () => ({ model, modelId, supportsFunctionCalling: true }),
      getMaxTurns: () => maxTurns,
    },
    sessions: {
      getSession: (id) => {
        if (id !== sessionId) return null
        const current = runtime.getSession(sessionId)
        if (!current || current.status !== 'running') return null
        return {
          sessionId: current.id,
          workspaceId: CLI_WORKSPACE_ID,
          workspaceRoot: current.workspace.workspaceRoot,
          status: current.status,
        }
      },
    },
    tools: {
      executeFunctionCall: (input, callerId) => runtime.executeTool(input, callerId),
      registry: {
        list: () => runtime.registry.list(),
        listManifests: () => createToolManifests(runtime.registry.list()),
      },
    },
    streamTextFn,
  }

  const controller = new AbortController()
  if (io.onSigint) io.onSigint(() => controller.abort())
  else process.once('SIGINT', () => controller.abort())

  const requestId = randomUUID()
  const conversationId = options.conversationId ?? requestId
  try {
    const result = await runChatTurn(
      {
        requestId,
        messages: [{ role: 'user', content: options.prompt }],
        providerId: 'cli',
        modelId,
        sourceTag: 'janus-chat',
        conversationId,
        workspaceId: CLI_WORKSPACE_ID,
        workspacePath: workspaceRoot,
        workspaceResources: [{
          workspaceId: CLI_WORKSPACE_ID,
          workspacePath: workspaceRoot,
          workspaceName: basename(workspaceRoot) || CLI_WORKSPACE_ID,
          agentSessionId: sessionId,
        }],
      },
      ports,
      { onEvent: (event) => stdout(JSON.stringify({ requestId, event })) },
      controller.signal,
    )
    if (result.cancelled || controller.signal.aborted) return 130
    return 0
  } catch (error) {
    stderr(`janus: chat turn failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    console.error(`janus: ${parsed.error}`)
    console.error(helpText())
    return 2
  }
  switch (parsed.command) {
    case 'help':
      console.log(helpText())
      return 0
    case 'version':
      console.log('0.2.0')
      return 0
    case 'chat':
      return runChat(parsed.chat ?? { workspace: process.cwd(), prompt: '' })
  }
}

const invokedAsCli = typeof process.argv[1] === 'string'
  && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('janus'))
if (invokedAsCli) {
  void main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(`janus: unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
