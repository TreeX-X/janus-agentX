#!/usr/bin/env node
/**
 * @file janus CLI entry. Pure Node (no Electron, no node-pty).
 * Mirrors the JanusX office-launcher pattern: testable runXxx() functions
 * behind a process.argv[1] guard so tests can import without side effects.
 */
import { randomUUID } from 'node:crypto'
import { AgentStreamManager, resolveCLIPath } from '@janus-agent/agent-core'
import { helpText, parseArgs } from './args.js'

export async function runResolve(engine: 'claude' | 'codex' | 'opencode'): Promise<number> {
  const cliPath = await resolveCLIPath(engine)
  if (!cliPath) {
    console.error(`janus: CLI not found for engine: ${engine}`)
    return 3
  }
  console.log(cliPath)
  return 0
}

export async function runAgent(
  options: {
    engine: 'claude' | 'codex' | 'opencode'
    cwd: string
    model?: string
    timeoutMs?: number
    approvalMode?: 'per-action' | 'auto-run'
    prompt: string
  },
  io: {
    stdout?: (line: string) => void
    onSigint?: (handler: () => void) => void
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line))
  const cliPath = await resolveCLIPath(options.engine)
  if (!cliPath) {
    console.error(`janus: CLI not found for engine: ${options.engine}`)
    return 3
  }

  const manager = new AgentStreamManager({ maxConcurrency: 1 })
  const id = randomUUID()
  let finished = false
  let hadError = false
  let interrupted = false
  let finish: () => void = () => undefined
  const done = new Promise<void>((resolve) => { finish = resolve })

  manager.onEvent(id, (event) => {
    stdout(JSON.stringify({ sessionId: id, event }))
    if (event.type === 'error') hadError = true
    if (event.type === 'done') {
      finished = true
      finish()
    }
  })

  const onSigint = () => {
    interrupted = true
    manager.cancel(id)
  }
  if (io.onSigint) io.onSigint(onSigint)
  else process.once('SIGINT', onSigint)

  try {
    await manager.startWithId(id, {
      engine: options.engine,
      prompt: options.prompt,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    })
  } catch (error) {
    console.error(`janus: failed to start agent: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  await done
  if (!finished) return 1
  if (interrupted) return 130
  return hadError ? 1 : 0
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
      console.log('0.1.0')
      return 0
    case 'resolve':
      return runResolve(parsed.resolveEngine ?? 'codex')
    case 'run':
      return runAgent(parsed.run ?? { engine: 'codex', cwd: process.cwd(), prompt: '' })
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
