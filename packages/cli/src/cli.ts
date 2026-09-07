#!/usr/bin/env node
/**
 * @file janus CLI entry. Pure Node (no Electron, no subprocess runner).
 * `chat` runs one headless turn (JSONL on stdout); `tui` (default with no
 * argv) runs the resident interactive loop. Both share `CliSession`, the
 * single owner of runtime + agent session + multi-turn history. Testable
 * runChat()/runRepl() sit behind a process.argv[1] guard so tests import
 * without side effects.
 */
import { helpText, parseArgs } from './args.js'
import type { ChatOptions } from './args.js'
import { CliSession, isSessionValidationError } from './session.js'
import { runRepl } from './repl.js'
import type { TuiOptions } from './args.js'

export interface ChatRunIO {
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  env?: NodeJS.ProcessEnv
  onSigint?: (handler: () => void) => void
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: Parameters<typeof CliSession.create>[0]['streamTextFn']
}

export async function runChat(options: ChatOptions, io: ChatRunIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line))
  const stderr = io.stderr ?? ((line: string) => console.error(line))

  const session = await CliSession.create({ ...options, env: io.env, streamTextFn: io.streamTextFn })
  if (isSessionValidationError(session)) {
    stderr(session.message)
    return 2
  }

  const controller = new AbortController()
  if (!io.streamTextFn && !io.onSigint) {
    process.once('SIGINT', () => controller.abort())
  }
  if (io.onSigint) io.onSigint(() => controller.abort())

  try {
    const result = await session.sendTurn(
      options.prompt,
      { onEvent: ({ requestId, event }) => stdout(JSON.stringify({ requestId, event })) },
      controller.signal,
    )
    if (result.cancelled || controller.signal.aborted) return 130
    return 0
  } catch (error) {
    stderr(`janus: chat turn failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await session.close()
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
    case 'tui': {
      const tui: TuiOptions = parsed.tui ?? { workspace: process.cwd() }
      if (tui.fullscreen) {
        console.error('janus: --fullscreen (Ink) lands in M1; running plain loop for now.')
      }
      return runRepl(tui)
    }
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
