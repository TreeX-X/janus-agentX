/**
 * @file Ink fullscreen TUI root (opencode-style resident terminal).
 * @description Three-pane layout — header / discussion (flexGrow) /
 * composer+statusbar pinned to the bottom — over the shared `CliSession` +
 * `executeCommand`. No background fills anywhere: the terminal's own black
 * is the background. System reminders (missing model/key…) render as
 * `notice` divider cards, never as raw console output. ChatAgentEvents flow
 * into the pure `store.ts` reducer; per-action approvals resolve through an
 * inline y/n gate. Plain loop (`repl.ts`) stays for pipes and `--plain`.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ChatAgentEvent } from '@janus-agent/chat-core'
import type { ApprovalPrompt, CliSession } from '../session.js'
import {
  createInitialState,
  reduceTuiState,
  type ChatMessageView,
} from './store.js'
import { executeCommand } from './exec.js'
import { parseInputLine } from '../commands.js'
import { LOGO_TONE, renderLogoJanusLine, renderLogoXLine } from '../logo.js'
import { Composer } from './Composer.js'
import { TOOL_CARD_BG, toolCardFg, toolCardLine } from './tool-card.js'
import { padToWidth, truncateToWidth } from './composer-state.js'
import { useTerminalSize } from './terminal-size.js'

/**
 * Gray-orange theme, mirroring the JanusX chat palette:
 * orange `#ff7830` accent, `#8a8f98` secondary gray, `#e8e8e8` body text.
 */
const THEME = {
  accent: LOGO_TONE.orange,
  muted: LOGO_TONE.dim,
  body: LOGO_TONE.lit,
} as const

export interface InkHost {
  createSession(workspaceDir: string): Promise<CliSession | { error: string }>
}

interface AppProps {
  initialSession: CliSession
  host: InkHost
  onExit: (code: number) => void
  /** System reminders shown as divider cards, never as raw console output. */
  initialNotices?: string[]
}

/** JanusX empty-state banner: JANUS in gray-white, X in orange/gray dual tone. */
function EmptyBanner(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {[0, 1, 2, 3, 4].map((row) => (
        <Box key={row}>
          <Text color={THEME.body}>{renderLogoJanusLine(row)}</Text>
          <Text>{'  '}</Text>
          {renderLogoXLine(row).map((run, index) => (
            <Text
              key={index}
              color={run.tone === 'orange' ? THEME.accent : run.tone === 'dim' ? THEME.muted : undefined}
            >
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function NoticeRow({ text, width }: { text: string; width: number }): React.JSX.Element {
  const rule = '─'.repeat(Math.max(8, width))
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={THEME.muted}>{rule}</Text>
      {text.split('\n').map((line, index) => (
        <Text key={index}>
          <Text color={THEME.accent}>{'○ '}</Text>
          <Text color={THEME.body}>{line || ' '}</Text>
        </Text>
      ))}
      <Text color={THEME.muted}>{rule}</Text>
    </Box>
  )
}

function MessageRow({ message, width }: { message: ChatMessageView; width: number }) {
  if (message.role === 'notice') {
    return <NoticeRow text={message.text} width={width} />
  }
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={THEME.muted} bold>you ›</Text>
        <Text color={THEME.body}>{message.text}</Text>
      </Box>
    )
  }
  if (message.role === 'info') {
    return (
      <Box marginBottom={1}>
        <Text color={THEME.muted}>{message.text}</Text>
      </Box>
    )
  }
  if (message.role === 'error') {
    return (
      <Box marginBottom={1}>
        <Text color="red">✘ {message.text}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={THEME.accent} bold>janus ›</Text>
      <Text color={THEME.body}>{message.text}</Text>
    </Box>
  )
}

export function App({ initialSession, host, onExit, initialNotices = [] }: AppProps): React.JSX.Element {
  const [, setSession] = useState<CliSession>(initialSession)
  const sessionRef = useRef<CliSession>(initialSession)
  const [state, dispatch] = useReducer(reduceTuiState, undefined, createInitialState)
  const [input, setInput] = useState('')
  // Live terminal size (opencode `dimensions()` equivalent): every resize
  // re-renders with fresh geometry — nothing layout-related is frozen at
  // mount.
  const { columns, rows: termHeight } = useTerminalSize()
  // Discussion rows span the full width inside the root padding.
  const discW = Math.max(10, columns - 2)
  // Full-height terminal: discussion flexGrows, composer stays pinned at bottom.
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  const noticesRef = useRef<string[]>(initialNotices)
  noticesRef.current = initialNotices

  const refreshContext = useCallback(() => {
    const current = sessionRef.current
    const active = current.listConversations().find((summary) => summary.id === current.getConversationId())
    dispatch({
      type: 'context',
      labels: {
        modelLabel: `${current.getProviderId()}/${current.getModelId() ?? '(no model)'}`,
        workspaceLabel: current.getWorkspaceName(),
        approvalLabel: current.getApprovalMode(),
        conversationLabel: active?.title ?? '',
      },
    })
  }, [])

  const hydrate = useCallback(() => {
    const current = sessionRef.current
    dispatch({
      type: 'hydrate',
      messages: current.getActiveMessages().map((message) => ({ role: message.role, text: message.content })),
    })
    refreshContext()
  }, [refreshContext])

  // Bridge runtime approvals into an inline y/n gate.
  const bridgeApproval = useCallback(async (prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> => {
    dispatch({
      type: 'approval-requested',
      approval: {
        toolName: prompt.toolName,
        workspaceId: prompt.workspaceId,
        actionRisk: prompt.actionRisk,
        summary: prompt.summary,
        paths: prompt.paths,
      },
    })
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean): void => {
        if (approvalResolveRef.current == null) return
        approvalResolveRef.current = null
        signal.removeEventListener('abort', onAbort)
        dispatch({ type: 'approval-resolved' })
        resolve(approved)
      }
      const onAbort = (): void => done(false)
      approvalResolveRef.current = done
      if (signal.aborted) done(false)
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }, [])

  useEffect(() => {
    sessionRef.current.setApprovalHandler(bridgeApproval)
    hydrate()
    for (const notice of noticesRef.current) {
      if (notice.trim()) dispatch({ type: 'notice', text: notice })
    }
  }, [bridgeApproval, hydrate])

  // Note: no cursor code lives here. The mounted Composer owns the caret
  // through `useSyncedCaret()` (real native cursor while focused, hidden
  // while busy/disabled); when the approval gate unmounts it, Ink clears
  // that intent itself, so no stale cursor can leak.
  const runTurn = useCallback(async (prompt: string): Promise<void> => {
    const current = sessionRef.current
    dispatch({ type: 'user-message', text: prompt })
    dispatch({ type: 'turn-start' })
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await current.sendTurn(
        prompt,
        { onEvent: ({ event }) => dispatch({ type: 'agent-event', event: event as ChatAgentEvent }) },
        controller.signal,
      )
      dispatch({ type: 'turn-done', cancelled: result.cancelled, assistantText: result.text })
    } catch (error) {
      dispatch({ type: 'turn-done', cancelled: true, assistantText: '' })
      const raw = error instanceof Error ? error.message : String(error)
      // Missing model/key are configuration reminders, not turn failures:
      // show them as divider cards instead of harsh red errors.
      if (/missing model|missing API key|no model|no API key/i.test(raw)) {
        dispatch({ type: 'notice', text: raw })
      } else {
        dispatch({ type: 'error', text: `janus: chat turn failed: ${raw}` })
      }
    } finally {
      busyRef.current = false
      setBusy(false)
      controllerRef.current = null
      refreshContext()
    }
  }, [refreshContext])

  const runCommand = useCallback(async (command: string, args: string[]): Promise<void> => {
    const outcome = await executeCommand(sessionRef.current, command, args, {
      recreateWorkspace: async (dir) => {
        const created = await host.createSession(dir)
        if (typeof (created as { error?: string }).error === 'string') {
          return { ok: false, message: (created as { error: string }).error }
        }
        await sessionRef.current.close()
        const next = created as CliSession
        sessionRef.current = next
        setSession(next)
        next.setApprovalHandler(bridgeApproval)
        return { ok: true, message: `workspace switched: ${next.getWorkspaceRoot()} (history cleared)` }
      },
    })
    if (outcome.exit) {
      exitRef.current(0)
      return
    }
    // Hydrate first so the outcome lines land on top of fresh state instead
    // of being wiped by it (new/switch/delete/clear/workspace reset the view).
    const needsHydrate = command === 'clear' || command === 'workspace' || outcome.workspaceSwitched
      || command === 'new' || command === 'switch' || command === 'delete'
    if (needsHydrate) hydrate()
    else refreshContext()
    for (const line of outcome.stdout) dispatch({ type: 'info', text: line })
    for (const line of outcome.stderr) dispatch({ type: 'error', text: line })
  }, [host, hydrate, refreshContext])

  const submit = useCallback((raw: string): void => {
    if (busyRef.current) return
    const parsed = parseInputLine(raw)
    setInput('')
    if (parsed.kind === 'empty') return
    if (parsed.kind === 'command') {
      if (!parsed.known) {
        dispatch({ type: 'error', text: `unknown command: /${parsed.command} (type /help)` })
        return
      }
      void runCommand(parsed.command as string, parsed.args ?? [])
      return
    }
    void runTurn(parsed.text ?? '')
  }, [runCommand, runTurn])

  useInput((inputValue, key) => {
    if (key.ctrl && inputValue === 'c') {
      if (controllerRef.current) controllerRef.current.abort()
      else exitRef.current(0)
      return
    }
    if (key.ctrl && inputValue === 'd') {
      exitRef.current(0)
      return
    }
    if (state.awaitingApproval) {
      const answer = inputValue.toLowerCase()
      if (answer === 'y') approvalResolveRef.current?.(true)
      else if (answer === 'n' || key.escape) approvalResolveRef.current?.(false)
    }
  })

  const approval = state.awaitingApproval
  // Notices are system reminders (missing model/key…): they render as divider
  // cards but must not hide the empty-state banner.
  const contentMessages = state.messages.filter((message) => message.role !== 'notice')
  const noticeMessages = state.messages.filter((message) => message.role === 'notice')
  const empty = contentMessages.length === 0 && !state.pendingText
  // Single-line status bar, truncated to the live width so narrow
  // terminals never wrap it out of the pinned bottom chrome.
  const footerText = truncateToWidth(
    `${state.conversationLabel ? `${state.conversationLabel} · ` : ''}${state.statusText ? `${state.statusText} · ` : ''}/help · Tab 补全 · Shift+Enter 换行 · ctrl+c cancel · ctrl+d exit`,
    discW,
  )

  return (
    // Ink's cursor protocol needs a trailing newline. Reserve its terminal row
    // so repaint and cursor-only updates share the same output origin.
    <Box flexDirection="column" paddingX={1} height={termHeight == null ? undefined : Math.max(1, termHeight - 1)}>
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexShrink={0}>
        <Text bold color={THEME.accent}>janus</Text>
        <Text color="gray"> · {state.workspaceLabel} · {state.modelLabel} · {state.approvalLabel}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" justifyContent={empty ? 'flex-start' : 'flex-end'} marginY={1}>
        {empty ? (
          <Box flexDirection="column" marginY={1}>
            <EmptyBanner />
            {noticeMessages.map((message) => <MessageRow key={message.id} message={message} width={discW} />)}
          </Box>
        ) : (
          <Box flexDirection="column" flexShrink={0}>
            {state.messages.map((message) => <MessageRow key={message.id} message={message} width={discW} />)}
            {state.toolCards.map((card) => (
              <Text key={card.callId} backgroundColor={TOOL_CARD_BG}>
                <Text backgroundColor={TOOL_CARD_BG} color={toolCardFg(card.status)}>
                  {padToWidth(truncateToWidth(toolCardLine(card), discW), discW)}
                </Text>
              </Text>
            ))}
            {state.pendingText ? <Text color={THEME.accent}>janus › {state.pendingText}▍</Text> : null}
            {!state.pendingText && state.status === 'thinking' ? <Text color={THEME.muted}>janus › thinking…</Text> : null}
            {state.pendingReasoningChars > 0 && !state.pendingText ? (
              <Text color={THEME.muted}>▸ reasoning ({state.pendingReasoningChars} chars, folded)</Text>
            ) : null}
          </Box>
        )}
      </Box>

      <Box flexShrink={0} flexDirection="column">
        {approval ? (
          <Box borderStyle="round" borderColor={THEME.accent} paddingX={1} flexDirection="column">
            <Text color={THEME.accent} bold>
              ◇ approve {approval.toolName}[{approval.workspaceId}] risk={approval.actionRisk}
              {approval.summary ? ` — ${approval.summary}` : ''}{approval.paths?.length ? ` (${approval.paths.join(', ')})` : ''}
            </Text>
            <Text color={THEME.muted}>Allow? press <Text bold color={THEME.body}>y</Text> / <Text bold color={THEME.body}>n</Text></Text>
          </Box>
        ) : (
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submit}
            disabled={busy || approval != null}
            busy={busy}
          />
        )}
      </Box>

      <Box marginTop={1} flexShrink={0}>
        <Text color="gray">{footerText}</Text>
      </Box>
    </Box>
  )
}
