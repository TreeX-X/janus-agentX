/**
 * @file Fullscreen Ink host (default on TTY; `--plain`/pipes use repl.ts).
 * @description Assembles store + catalog + session exactly like the plain
 * loop, then renders <App/>. Startup reminders (missing model/key,
 * unreadable config…) arrive as `initialNotices` divider cards inside the
 * TUI — never as raw console output above it. Ink stays inside `tui/`;
 * core packages never import React.
 */
import { render, type Instance } from 'ink'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { TuiOptions } from '../args.js'
import { CliSession, isSessionValidationError } from '../session.js'
import { defaultHistoryDir, fileConversationStore } from '../conversations.js'
import { loadEffectiveCatalog } from '../providers.js'
import { App } from './App.js'
import { CARET_BLOCK, CARET_DEFAULT, restoreNativeCaret, setCaretShape } from './terminal-size.js'

export interface FullscreenIO {
  env?: NodeJS.ProcessEnv
  /** Test seam: bypasses the real model transport. */
  streamTextFn?: ChatTurnPorts['streamTextFn']
}

export async function runFullscreen(options: TuiOptions, io: FullscreenIO = {}): Promise<number> {
  const env = io.env ?? process.env
  // Startup reminders become divider cards inside <App/>, not console noise
  // above the fullscreen UI (direct console output reads as harsh/jarring).
  const notices: string[] = []
  const pushNotice = (message: string): void => {
    if (!notices.includes(message)) notices.push(message)
  }
  let appStarted = false
  const store = fileConversationStore(defaultHistoryDir(), () => {
    if (!appStarted) pushNotice('janus: history file unavailable, this run keeps memory only.')
  })
  const catalogInput = loadEffectiveCatalog({
    model: options.model,
    baseUrl: options.baseUrl,
    onError: () => pushNotice('janus: provider config unreadable, using flags/env only.'),
  })
  const created = await CliSession.create({
    ...options,
    env,
    store,
    catalog: catalogInput.catalog,
    configPath: catalogInput.configPath,
    onCatalogError: () => pushNotice('janus: provider config not writable, switches last this run only.'),
    streamTextFn: io.streamTextFn,
  })
  if (isSessionValidationError(created)) {
    console.error(created.message)
    return 2
  }
  if (!created.getModelId()) {
    pushNotice('janus: no model — entering without model access. Set one with /model <id>, --model, or JANUS_MODEL.')
  }
  if (!created.hasApiKey()) {
    pushNotice('janus: no API key — entering without model access. Set one with /key <key>, --api-key, or JANUS_API_KEY.')
  }
  // Every restart begins with a new empty conversation; previous ones are
  // dropped. An explicit --conversation id opts back into resume.
  if (!options.conversationId) {
    await created.startFreshConversation()
  }
  const makeSession = async (workspaceDir: string): Promise<CliSession | { error: string }> => {
    const next = await CliSession.create({
      workspace: workspaceDir,
      model: created.getModelId(),
      baseUrl: options.baseUrl,
      apiKey: created.getApiKey() ?? options.apiKey,
      timeoutMs: options.timeoutMs,
      approvalMode: created.getApprovalMode(),
      env,
      store,
      catalog: created.getCatalog(),
      providerId: created.getProviderId(),
      configPath: catalogInput.configPath,
      // Post-render: never write to console (would corrupt fullscreen Ink);
      // the switch itself still succeeds for this run.
      onCatalogError: () => undefined,
      streamTextFn: io.streamTextFn,
    })
    if (isSessionValidationError(next)) return { error: next.message }
    return next
  }

  let app: Instance | undefined
  // The TUI hides the native cursor while running: guarantee the shell
  // gets a visible cursor back no matter how we leave (Ink's own teardown
  // also restores it; this is the belt-and-suspenders path). The caret
  // shape is ours too (steady block, opencode-style): restore the
  // terminal default alongside visibility for the same reason.
  const restoreCursor = (): void => {
    try {
      restoreNativeCaret(process.stdout)
    } catch {
      // Best effort: teardown must not fail.
    }
    try {
      setCaretShape(process.stdout, CARET_DEFAULT)
    } catch {
      // Best effort: teardown must not fail.
    }
  }
  try {
    const code = await new Promise<number>((resolve) => {
      appStarted = true
      app = render(
        <App
          initialSession={created}
          host={{ createSession: makeSession }}
          onExit={resolve}
          initialNotices={notices}
        />,
      )
      // Steady block caret for the whole run (see `terminal-size.ts`):
      // TTY-gated, so pipes/tests never see it.
      try {
        setCaretShape(process.stdout, CARET_BLOCK)
      } catch {
        // Best effort: a missed shape write must not break startup.
      }
    })
    return code
  } finally {
    app?.unmount()
    restoreCursor()
    await created.close()
  }
}
