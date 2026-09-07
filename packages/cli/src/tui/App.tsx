/**
 * @file Ink fullscreen TUI root (opencode-style resident terminal).
 * @description Three-pane layout — header / discussion / composer+statusbar —
 * over the shared `CliSession` + `executeCommand`. ChatAgentEvents flow into
 * the pure `store.ts` reducer; per-action approvals resolve through an
 * inline y/n gate. Plain loop (`repl.ts`) stays for pipes and `--plain`.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { ChatAgentEvent } from '@janus-agent/chat-core'
import type { ApprovalPrompt, CliSession } from '../session.js'
import {
  createInitialState,
  reduceTuiState,
  type ChatMessageView,
  type ToolCardView,
} from './store.js'
import { executeCommand } from './exec.js'
import { parseInputLine } from '../commands.js'
import { renderLogoAscii } from '../logo.js'

export interface InkHost {
  createSession(workspaceDir: string): Promise<CliSession | { error: string }>
}

interface AppProps {
  initialSession: CliSession
  host: InkHost
  onExit: (code: number) => void
}

function cardGlyph(status: ToolCardView['status']): string {
  switch (status) {
    case 'ready': return '◇'
    case 'running': return '◐'
    case 'completed': return '✔'
    case 'failed': return '✘'
  }
}

function cardColor(status: ToolCardView['status']): string {
  switch (status) {
    case 'completed': return 'green'
    case 'failed': return 'red'
    case 'running': return 'yellow'
    case 'ready': return 'gray'
  }
}

function MessageRow({ message }: { message: ChatMessageView }) {
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="green" bold>you ›</Text>
        <Text>{message.text}</Text>
      </Box>
    )
  }
  if (message.role === 'info') {
    return (
      <Box marginBottom={1}>
        <Text color="gray">{message.text}</Text>
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
      <Text color="cyan" bold>janus ›</Text>
      <Text>{message.text}</Text>
    </Box>
  )
}

export function App({ initialSession, host, onExit }: AppProps): React.JSX.Element {
  const [, setSession] = useState<CliSession>(initialSession)
  const sessionRef = useRef<CliSession>(initialSession)
  const [state, dispatch] = useReducer(reduceTuiState, undefined, createInitialState)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  const refreshContext = useCallback(() => {
    const current = sessionRef.current
    const active = current.listConversations().find((summary) => summary.id === current.getConversationId())
    dispatch({
      type: 'context',
      labels: {
        modelLabel: `${current.getProviderId()}/${current.getModelId()}`,
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
  }, [bridgeApproval, hydrate])

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
      dispatch({ type: 'error', text: `janus: chat turn failed: ${error instanceof Error ? error.message : String(error)}` })
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

  const submit = useCallback((value: string): void => {
    if (busyRef.current) return
    const parsed = parseInputLine(value)
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
  const empty = state.messages.length === 0 && !state.pendingText

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>janus</Text>
        <Text color="gray"> · {state.workspaceLabel} · {state.modelLabel} · {state.approvalLabel}</Text>
      </Box>

      {empty ? (
        <Box flexDirection="column" marginY={1}>
          <Text>{renderLogoAscii()}</Text>
          <Text color="gray">Type a message to start · /help for commands</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginY={1}>
          {state.messages.map((message) => <MessageRow key={message.id} message={message} />)}
          {state.toolCards.map((card) => (
            <Text key={card.callId} color={cardColor(card.status)}>
              {cardGlyph(card.status)} {card.toolName}{card.detail ? ` (${card.detail})` : ''}{card.status === 'running' ? '…' : ''}
            </Text>
          ))}
          {state.pendingText ? <Text>janus › {state.pendingText}▍</Text> : null}
          {!state.pendingText && state.status === 'thinking' ? <Text color="gray">janus › thinking…</Text> : null}
          {state.pendingReasoningChars > 0 && !state.pendingText ? (
            <Text color="gray">▸ reasoning ({state.pendingReasoningChars} chars, folded)</Text>
          ) : null}
        </Box>
      )}

      {approval ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            ◇ approve {approval.toolName}[{approval.workspaceId}] risk={approval.actionRisk}
            {approval.summary ? ` — ${approval.summary}` : ''}{approval.paths?.length ? ` (${approval.paths.join(', ')})` : ''}
          </Text>
          <Text>Allow? press <Text bold>y</Text> / <Text bold>n</Text></Text>
        </Box>
      ) : (
        <Box borderStyle="round" borderColor={busy ? 'gray' : 'cyan'} paddingX={1}>
          <Text color={busy ? 'gray' : 'cyan'}>{'> '}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={busy ? 'working…' : 'message (/help)'} showCursor focus={!busy} />
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          {state.conversationLabel ? `${state.conversationLabel} · ` : ''}{state.statusText ? `${state.statusText} · ` : ''}/help · ctrl+c cancel · ctrl+d exit
        </Text>
      </Box>
    </Box>
  )
}
