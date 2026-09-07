/**
 * @file Fullscreen Ink host (default on TTY; `--plain`/pipes use repl.ts).
 * @description Assembles store + catalog + session exactly like the plain
 * loop, then renders <App/>. Ink stays inside `tui/`; core packages never
 * import React.
 */
import { render, type Instance } from 'ink'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { TuiOptions } from '../args.js'
import { CliSession, isSessionValidationError } from '../session.js'
import { defaultHistoryDir, fileConversationStore } from '../conversations.js'
import { loadEffectiveCatalog } from '../providers.js'
import { App } from './App.js'

export interface FullscreenIO {
  env?: NodeJS.ProcessEnv
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export async function runFullscreen(options: TuiOptions, io: FullscreenIO = {}): Promise<number> {
  const env = io.env ?? process.env
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    console.error(message)
  }
  const store = fileConversationStore(defaultHistoryDir(), () => {
    warnOnce('janus: history file unavailable, this run keeps memory only.')
  })
  const catalogInput = loadEffectiveCatalog({
    model: options.model,
    baseUrl: options.baseUrl,
    onError: () => warnOnce('janus: provider config unreadable, using flags/env only.'),
  })
  const created = await CliSession.create({
    ...options,
    env,
    store,
    catalog: catalogInput.catalog,
    configPath: catalogInput.configPath,
    onCatalogError: () => warnOnce('janus: provider config not writable, switches last this run only.'),
    streamTextFn: io.streamTextFn,
  })
  if (isSessionValidationError(created)) {
    console.error(created.message)
    return 2
  }
  const makeSession = async (workspaceDir: string): Promise<CliSession | { error: string }> => {
    const next = await CliSession.create({
      workspace: workspaceDir,
      model: created.getModelId(),
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      approvalMode: created.getApprovalMode(),
      env,
      store,
      catalog: created.getCatalog(),
      providerId: created.getProviderId(),
      configPath: catalogInput.configPath,
      onCatalogError: () => warnOnce('janus: provider config not writable, switches last this run only.'),
      streamTextFn: io.streamTextFn,
    })
    if (isSessionValidationError(next)) return { error: next.message }
    return next
  }

  let app: Instance | undefined
  const code = await new Promise<number>((resolve) => {
    app = render(
      <App
        initialSession={created}
        host={{ createSession: makeSession }}
        onExit={resolve}
      />,
    )
  })
  app?.unmount()
  await created.close()
  return code
}
