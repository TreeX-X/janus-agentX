/**
 * @file Ink fullscreen TUI root (opencode-style resident terminal).
 * @description Three-pane layout — statusline / discussion (flexGrow) /
 * composer+statusbar pinned to the bottom — over the shared `CliSession` +
 * `executeCommand`. Pure-black discipline: no area fills anywhere (focus
 * lives in accent edges, segmented footer colors and dark selected rows,
 * never in gray panels); the terminal background shows through everywhere. System
 * reminders (missing model/key…) render as `notice` divider cards, never
 * as raw console output. ChatAgentEvents flow into the pure `store.ts`
 * reducer; per-action approvals resolve through a Confirm/Cancel gate
 * (arrows + Enter). Plain loop (`repl.ts`) stays for pipes and `--plain`.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, measureElement, useInput, useStdout, type DOMElement } from 'ink'
import type { ChatAgentEvent, ChatTodoItem } from '@janus-agent/chat-core'
import { hasOpenTodos, summarizeTodos } from '@janus-agent/chat-core'
import type { ApprovalPrompt, CliSession, QuestionPrompt } from '../session.js'
import type { AskUserPortAnswer } from '@janus-agent/janus-agent'
import { QuestionPanel } from './question-panel.js'
import {
  buildFooterText,
  createInitialState,
  formatTokenUsage,
  reduceTuiState,
  type TimelineBlock,
} from './store.js'
import { executeCommand } from './exec.js'
import type { TestConnectionFn } from '../connect.js'
import { CommandPalette, ApprovalPanel, EffortPanel, PanelFrame, type PaletteItem } from './palette.js'
import { effortMeta } from '../effort.js'
import { ConnectPanel } from './connect-panel.js'
import { parseInputLine } from '../commands.js'
import { LOGO_TONE, TUI_CHROME, renderLogoJanusLine, renderLogoXLine } from '../logo.js'
import { Composer, type ComposerMouseControl } from './Composer.js'
import { Markdown } from './Markdown.js'
import { Activity, duration } from './Activity.js'
import { displayText } from '../tool-display.js'
import { toolCardFg, toolCardLine } from './tool-card.js'
import { displayWidth, padToWidth, pushInputHistory, truncateToWidth, type ComposerFrameRect, type TerminalOffset } from './composer-state.js'
import { TUI_HORIZONTAL_PADDING, useTerminalSize } from './terminal-size.js'
import {
  clampScrollOffset,
  containsMouseSequence,
  maintainMouseReporting,
  CPR_QUERY,
  LINE_SCROLL_LINES,
  pageStep,
  parseCprReplies,
  parseSgrMouseEvents,
  parseWheelDelta,
  shouldCaptureMouse,
  type CprPosition,
  type SgrMouseEvent,
} from './scroll.js'

/**
 * Minimal cool theme (design/janus-TUI-design.html): copper accent,
 * graphite secondary, soft-white body. Values come from LOGO_TONE so a
 * single palette edit re-skins the whole TUI.
 */
const THEME = {
  accent: LOGO_TONE.orange,
  muted: LOGO_TONE.dim,
  body: LOGO_TONE.lit,
  /** Empty-state logo secondary: high-contrast gray, not the muted text tone. */
  logoDim: LOGO_TONE.xDim,
} as const

export interface InkHost {
  createSession(workspaceDir: string): Promise<CliSession | { error: string }>
  /** Reachability probe for /connect (defaults to a live GET /models). */
  testConnection?: TestConnectionFn
}

interface AppProps {
  initialSession: CliSession
  host: InkHost
  onExit: (code: number) => void
  /** System reminders shown as divider cards, never as raw console output. */
  initialNotices?: string[]
}

/** JanusX empty-state banner: JANUS in gray-white, X in orange/light-gray dual tone. */
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
              color={run.tone === 'orange' ? THEME.accent : run.tone === 'dim' ? THEME.logoDim : undefined}
            >
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Collapsible todo box pinned above the composer (design/janus-TUI-design.html):
 * a bordered card with a single-line summary (`○ 待办 d/t │ 当前: …`) plus an
 * expand hint; expanded it lists every item under a faint rule. Read-only
 * mirror of the model's `todo_write` list: hidden when empty or fully done.
 * Toggle with `toggle-todos` (ctrl+e); `Ctrl+D` stays reserved for exit.
 */
function TodoStickyBar({ todos, width, expanded }: { todos: ChatTodoItem[]; width: number; expanded: boolean }): React.JSX.Element | null {
  if (!hasOpenTodos(todos)) return null
  const summary = summarizeTodos(todos)
  const innerW = Math.max(8, width - 4)
  const toggleHint = expanded ? '收起 ▼' : '展开 ▲'
  const headLeft = `○ 待办 ${summary.done}/${summary.total}${summary.current ? ` │ 当前: ${summary.current}` : ''}`
  const head = truncateToWidth(headLeft, Math.max(8, innerW - displayWidth(toggleHint) - 5))
  const icon = (status: ChatTodoItem['status']): string => {
    switch (status) {
      case 'completed': return '●'
      case 'in_progress': return '◐'
      case 'cancelled': return '✕'
      default: return '○'
    }
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={TUI_CHROME.cardBorder}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text color={THEME.accent}>{head}</Text>
        <Text color={THEME.muted}>{toggleHint} · ctrl+e</Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column">
          <Text color={THEME.muted}>{'─'.repeat(innerW)}</Text>
          {todos.map((todo, index) => (
            <Text key={index} color={todo.status === 'in_progress' ? TUI_CHROME.yellow : THEME.muted}>
              {truncateToWidth(`  ${icon(todo.status)} ${todo.content}`, innerW)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function NoticeRow({ text, width }: { text: string; width: number }): React.JSX.Element {  const rule = '─'.repeat(Math.max(8, width))
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

function TimelineRow({ block, width, live, thinkingExpanded, toolsExpanded = false }: {
  block: TimelineBlock
  width: number
  live: boolean
  thinkingExpanded: boolean
  toolsExpanded?: boolean
}): React.JSX.Element {
  if (block.kind === 'notice') {
    return <NoticeRow text={block.text} width={width} />
  }
  if (block.kind === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={THEME.muted} bold>you ›</Text>
        <Text color={THEME.body}>{displayText(block.text)}</Text>
      </Box>
    )
  }
  if (block.kind === 'info') {
    return (
      <Box marginBottom={1}>
        <Text color={THEME.muted}>{displayText(block.text)}</Text>
      </Box>
    )
  }
  if (block.kind === 'error') {
    return (
      <Box marginBottom={1}>
        <Text color={TUI_CHROME.red}>✘ {displayText(block.text)}</Text>
      </Box>
    )
  }
  if (block.kind === 'thinking') {
    const elapsed = block.startedAt && block.endedAt ? ` · ${duration(block.endedAt - block.startedAt)}` : ''
    if (!thinkingExpanded) {
      const firstLine = displayText(block.text).split('\n').find((line) => line.trim()) ?? ''
      const gist = firstLine.replace(/^#+\s+|\*\*/g, '')
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={TUI_CHROME.yellow}>{truncateToWidth(`▸ thinking${elapsed} · ${gist}`, width)}</Text>
          {live ? <Text color={THEME.muted} italic>{truncateToWidth(displayText(block.text).trim().split('\n').at(-1) ?? '', Math.max(1, width - 1))}▍</Text> : null}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={TUI_CHROME.yellow}>▸ thinking{elapsed}</Text>
        <Markdown text={block.text} width={width} muted />
        {live ? <Text color={TUI_CHROME.yellow}>▍</Text> : null}
      </Box>
    )
  }
  if (block.kind === 'tool') {
    const face = {
      status: block.toolStatus ?? 'ready',
      toolName: block.toolName,
      detail: undefined,
    }
    const category = block.display?.category ?? 'tool'
    const categoryColors = {
      read: TUI_CHROME.cyan,
      search: TUI_CHROME.cyan,
      edit: TUI_CHROME.magenta,
      command: TUI_CHROME.green,
      git: TUI_CHROME.green,
      project: TUI_CHROME.yellow,
      tool: THEME.muted,
    }
    const elapsed = block.display?.durationMs ?? (block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined)
    const summary = block.display?.summary ?? block.toolSummary
    const output = block.toolPreview?.length ? block.toolPreview : block.display?.output ?? []
    const limit = toolsExpanded ? output.length : category === 'edit' || face.status === 'failed' ? 6 : 3
    const shown = output.slice(0, limit)
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={toolCardFg(face.status)}>▌ </Text>
          <Text color={toolCardFg(face.status)}>
            {padToWidth(truncateToWidth(`${toolCardLine(face)} · ${face.status}${elapsed !== undefined ? ` · ${duration(elapsed)}` : ''}`, Math.max(1, width - 2)), Math.max(1, width - 2))}
          </Text>
        </Text>
        {block.display?.target ? <Text color={categoryColors[category]}>  {category} › {block.display.target}</Text>
          : face.status === 'preparing' ? <Text color={THEME.muted}>  arguments · {block.argumentChars ?? 0} chars</Text>
            : block.toolDetail ? <Text color={THEME.muted}>  {block.toolDetail}</Text> : null}
        {summary ? <Text color={face.status === 'failed' ? TUI_CHROME.red : THEME.muted}>  └ {displayText(summary)}</Text> : null}
        {shown.map((line, index) => (
          <Text
            key={index}
            color={line.startsWith('+') ? TUI_CHROME.green : line.startsWith('-') ? TUI_CHROME.red : THEME.muted}
          >
            {'    '}{displayText(line)}
          </Text>
        ))}
        {output.length > shown.length ? <Text color={THEME.muted}>    … {output.length - shown.length} more lines</Text> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={THEME.accent} bold>janus ›</Text>
      <Markdown text={block.text} width={width} />
      {live ? <Text color={THEME.accent}>▍</Text> : null}
    </Box>
  )
}

export function App({ initialSession, host, onExit, initialNotices = [] }: AppProps): React.JSX.Element {
  const [, setSession] = useState<CliSession>(initialSession)
  const sessionRef = useRef<CliSession>(initialSession)
  const [state, dispatch] = useReducer(reduceTuiState, undefined, createInitialState)
  const [input, setInput] = useState('')
  // Submitted-input history for shell-style ↑/↓ recall in the composer.
  // Persists across turns/conversations; browsing state resets on submit.
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyDraft, setHistoryDraft] = useState('')
  // Live terminal size (opencode `dimensions()` equivalent): every resize
  // re-renders with fresh geometry — nothing layout-related is frozen at
  // mount.
  const { columns, rows: termHeight } = useTerminalSize()
  const discW = Math.max(10, columns - TUI_HORIZONTAL_PADDING * 2)
  const { stdout } = useStdout()
  const viewportRef = useRef<DOMElement>(null)
  const contentRef = useRef<DOMElement>(null)
  const [{ totalLines, viewportRows }, setGeometry] = useState({ totalLines: 0, viewportRows: 1 })
  // null follows output; an absolute row anchors history while more output arrives.
  const [scrollTop, setScrollTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const total = contentRef.current ? measureElement(contentRef.current).height : 0
    const viewport = Math.max(1, viewportRef.current ? measureElement(viewportRef.current).height : 1)
    if (total !== totalLines || viewport !== viewportRows) {
      setGeometry({ totalLines: total, viewportRows: viewport })
    }
  })
  const maxScroll = Math.max(0, totalLines - viewportRows)
  const visibleTop = scrollTop === null ? maxScroll : Math.min(scrollTop, maxScroll)
  const scrollBy = (lines: number): void => {
    setScrollTop((current) => {
      const next = clampScrollOffset((current === null ? maxScroll : Math.min(current, maxScroll)) + lines, totalLines, viewportRows)
      return next === maxScroll ? null : next
    })
  }
  // Notices are system reminders (missing model/key…): they render as divider
  // cards but must not hide the empty-state banner.
  const visibleBlocks = useMemo(
    () => state.blocks.filter((block) => block.kind !== 'notice'),
    [state.blocks],
  )
  const noticeBlocks = useMemo(
    () => state.blocks.filter((block) => block.kind === 'notice'),
    [state.blocks],
  )
  const empty = visibleBlocks.length === 0
  // Full-height terminal: discussion flexGrows, composer stays pinned at bottom.
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const pendingRef = useRef<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  const mountedRef = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const questionResolveRef = useRef<((answer: AskUserPortAnswer) => void) | null>(null)
  // Modal overlays (palette / provider setup). While open the composer is
  // disabled and global keys are suspended; the overlay owns its input.
  const [overlay, setOverlay] = useState<
    | { kind: 'palette' }
    | { kind: 'connect'; initial?: { ref?: string; key?: string; baseURL?: string } }
    | { kind: 'approval' }
    | { kind: 'effort' }
    | null
  >(null)
  const exitRef = useRef(onExit)
  const lastInterruptRef = useRef<number | null>(null)
  exitRef.current = onExit
  const noticesRef = useRef<string[]>(initialNotices)
  noticesRef.current = initialNotices

  const refreshContext = useCallback(() => {
    const current = sessionRef.current
    const active = current.listConversations().find((summary) => summary.id === current.getConversationId())
    dispatch({
      type: 'context',
      labels: {
        modelLabel: `${current.getProviderId()}/${current.getModelId() ?? '(no model)'} · ${current.getEffort()}`,
        workspaceLabel: current.getWorkspaceName(),
        approvalLabel: current.getApprovalMode(),
        conversationLabel: active?.title ?? '',
      },
    })
  }, [])

  const hydrate = useCallback(() => {
    const current = sessionRef.current
    // Switching conversations re-follows the tail.
    setScrollTop(null)
    dispatch({
      type: 'hydrate',
      messages: current.getActiveMessages().map((message) => ({ role: message.role, text: message.content })),
      todos: current.getActiveTodos(),
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
        detail: prompt.detail,
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

  // Bridge `ask_user` into the QuestionPanel. The panel view itself arrives
  // via `question_requested` agent events (emitted by the loop tool hooks);
  // this bridge only awaits the user's pick. Abort/Esc resolves cancelled.
  const bridgeQuestion = useCallback(async (_prompt: QuestionPrompt, signal: AbortSignal): Promise<AskUserPortAnswer> => {
    return new Promise<AskUserPortAnswer>((resolve) => {
      const done = (answer: AskUserPortAnswer): void => {
        if (questionResolveRef.current == null) return
        questionResolveRef.current = null
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => done({ status: 'cancelled' })
      questionResolveRef.current = done
      if (signal.aborted) done({ status: 'cancelled' })
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }, [])

  useEffect(() => {
    sessionRef.current.setApprovalHandler(bridgeApproval)
    sessionRef.current.setQuestionHandler(bridgeQuestion)
    hydrate()
    for (const notice of noticesRef.current) {
      if (notice.trim()) dispatch({ type: 'notice', text: notice })
    }
  }, [bridgeApproval, bridgeQuestion, hydrate])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRef.current = []
      controllerRef.current?.abort()
    }
  }, [])

  // Capture enables constrained input selection and wheel scrolling by
  // default. Explicit opt-outs return the mouse to the terminal and use
  // PgUp/PgDn/Ctrl+arrows. Captured wheel ticks arrive as SGR sequences
  // that `parseWheelDelta` turns into scroll steps in `useInput` below.
  useEffect(() => {
    if (!shouldCaptureMouse()) return
    return maintainMouseReporting(stdout)
  }, [stdout])

  // Note: no cursor code lives here. The mounted Composer owns the caret
  // through `useSyncedCaret()` (real native cursor while focused, hidden
  // while disabled); when the approval gate unmounts it, Ink clears
  // that intent itself, so no stale cursor can leak.
  const runTurn = useCallback(async (prompt: string): Promise<void> => {
    const current = sessionRef.current
    dispatch({ type: 'user-message', text: prompt })
    dispatch({ type: 'turn-start' })
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    controllerRef.current = controller
    let completed = false
    try {
      const result = await current.sendTurn(
        prompt,
        {
          onEvent: ({ event }) => dispatch({ type: 'agent-event', event: event as ChatAgentEvent }),
          onDisplayEvent: (event) => dispatch(event),
        },
        controller.signal,
      )
      dispatch({ type: 'turn-done', cancelled: result.cancelled, assistantText: result.text })
      completed = !result.cancelled && !controller.signal.aborted
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
      if (mountedRef.current) {
        refreshContext()
        if (completed) {
          const next = pendingRef.current.shift()
          setPending([...pendingRef.current])
          if (next !== undefined) void runTurn(next)
        } else if (pendingRef.current.length > 0) {
          const restored = pendingRef.current.join('\n\n')
          pendingRef.current = []
          setPending([])
          setHistoryIndex(null)
          setHistoryDraft('')
          setInput((draft) => draft ? `${restored}\n\n${draft}` : restored)
          dispatch({ type: 'info', text: 'Pending messages restored to input.' })
        }
      }
    }
  }, [refreshContext])

  const runCommand = useCallback(async (command: string, args: string[]): Promise<void> => {
    // /connect always opens the visual setup panel (the roster + wizard);
    // the text wizard in executeCommand serves the plain loop only.
    if (command === 'connect') {
      const [ref, key, baseURL] = args
      setOverlay({ kind: 'connect', initial: args.length > 0 ? { ref, key, baseURL } : {} })
      return
    }
    // Bare /approval opens the mode switch panel; with an arg it switches directly.
    if (command === 'approval' && args.length === 0) {
      setOverlay({ kind: 'approval' })
      return
    }
    // Bare /effort opens the interactive picker; with an arg it switches directly.
    if (command === 'effort' && args.length === 0) {
      setOverlay({ kind: 'effort' })
      return
    }
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
        next.setQuestionHandler(bridgeQuestion)
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
  }, [host, hydrate, refreshContext, bridgeApproval, bridgeQuestion])

  const submit = useCallback((raw: string): void => {
    const parsed = parseInputLine(raw)
    if (parsed.kind === 'empty') return
    if (busyRef.current) {
      if (parsed.kind === 'command') {
        dispatch({ type: 'info', text: 'Commands are available after the current turn finishes.' })
        return
      }
      setInputHistory((prev) => pushInputHistory(prev, raw))
      setHistoryIndex(null)
      setHistoryDraft('')
      pendingRef.current.push(parsed.text ?? '')
      setPending([...pendingRef.current])
      setInput('')
      setScrollTop(null)
      return
    }
    // Record for ↑/↓ recall before clearing; rejected busy commands above
    // and empty lines never enter history.
    setInputHistory((prev) => pushInputHistory(prev, raw))
    setHistoryIndex(null)
    setHistoryDraft('')
    // New input re-follows the tail.
    setScrollTop(null)
    setInput('')
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

  const handleHistoryRecall = useCallback((next: { value: string; index: number | null; draft: string }): void => {
    setInput(next.value)
    setHistoryIndex(next.index)
    setHistoryDraft(next.draft)
  }, [])

  // Ctrl+C while the composer owns focus (clear input / abort turn /
  // double-press exit). The active composer calls this only with no text
  // selected — a selection copies instead — so this handler skips while the
  // composer is active and the composer alone decides copy-vs-interrupt.
  const handleInterrupt = useCallback((): void => {
    const now = performance.now()
    if (lastInterruptRef.current !== null && now - lastInterruptRef.current <= 1000) {
      lastInterruptRef.current = null
      controllerRef.current?.abort()
      exitRef.current(0)
      return
    }
    lastInterruptRef.current = now
    setInput('')
    setHistoryIndex(null)
    setHistoryDraft('')
    setOverlay(null)
    controllerRef.current?.abort()
  }, [])

  // Any composer copy/cut/paste/select-all is intervening keyboard input: it
  // cancels a pending double-press exit so copy-then-interrupt never quits.
  const handleSelectionAction = useCallback((): void => {
    lastInterruptRef.current = null
  }, [])

  // Constrained drag selection (capture on): the terminal→Ink translation is
  // established once per geometry via CPR and cached; Composer publishes its
  // frame rect (caret included for snapshots) and exposes the drag handle.
  // Pending press/drag/release events wait for the CPR reply, then flush in
  // order — mapping always resolves against buffer content, never chrome.
  const frameRectRef = useRef<ComposerFrameRect | null>(null)
  const terminalOffsetRef = useRef<TerminalOffset | null>(null)
  const offsetTermRef = useRef<{ cols: number; rows: number } | null>(null)
  const composerMouseRef = useRef<ComposerMouseControl | null>(null)
  const cprPendingRef = useRef<{
    caretX: number
    caretY: number
    rectX: number
    rectY: number
    cols: number
    rows: number
    tries: number
    events: Array<{ kind: 'press' | 'move' | 'release'; x: number; y: number }>
  } | null>(null)

  const composerActiveForMouse = (): boolean =>
    overlay === null && state.awaitingApproval == null && !state.awaitingQuestion

  // A drag started behind an overlay/panel can never resolve: drop it.
  useEffect(() => {
    if (overlay !== null || state.awaitingApproval != null || state.awaitingQuestion) {
      cprPendingRef.current = null
    }
  }, [overlay, state.awaitingApproval, state.awaitingQuestion])

  const offsetValid = (): boolean => {
    const term = offsetTermRef.current
    return terminalOffsetRef.current !== null
      && term !== null
      && term.cols === columns
      && term.rows === (termHeight ?? 0)
  }

  const requestCpr = useCallback((): void => {
    try {
      const out = stdout as unknown as { isTTY?: unknown; write?: (data: string) => unknown }
      if (out?.isTTY === true && typeof out.write === 'function') out.write(CPR_QUERY)
    } catch {
      // Best effort: without a reply the gesture is dropped, never misplaced.
    }
  }, [stdout])

  const snapshotCpr = (): { caretX: number; caretY: number; rectX: number; rectY: number; cols: number; rows: number } | null => {
    const rect = frameRectRef.current
    if (!rect) return null
    return { caretX: rect.caretX, caretY: rect.caretY, rectX: rect.x, rectY: rect.y, cols: columns, rows: termHeight ?? 0 }
  }

  const flushCprPending = (): void => {
    const pending = cprPendingRef.current
    cprPendingRef.current = null
    if (!pending) return
    const control = composerMouseRef.current
    if (!control || !composerActiveForMouse()) return
    for (const event of pending.events) {
      if (event.kind === 'press') control.press(event.x, event.y)
      else if (event.kind === 'move') control.move(event.x, event.y)
      else control.release(event.x, event.y)
    }
  }

  const resolveCprReplies = (replies: CprPosition[]): void => {
    const pending = cprPendingRef.current
    const reply = replies.length > 0 ? replies[replies.length - 1] : undefined
    if (!pending || !reply) return
    if (!shouldCaptureMouse()) {
      cprPendingRef.current = null
      return
    }
    const now = snapshotCpr()
    const settled = now !== null
      && now.caretX === pending.caretX && now.caretY === pending.caretY
      && now.rectX === pending.rectX && now.rectY === pending.rectY
      && now.cols === pending.cols && now.rows === pending.rows
    if (settled) {
      terminalOffsetRef.current = { dx: pending.caretX - (reply.col - 1), dy: pending.caretY - (reply.row - 1) }
      offsetTermRef.current = { cols: pending.cols, rows: pending.rows }
      flushCprPending()
      return
    }
    if (pending.tries < 2 && now !== null) {
      pending.caretX = now.caretX
      pending.caretY = now.caretY
      pending.rectX = now.rectX
      pending.rectY = now.rectY
      pending.cols = now.cols
      pending.rows = now.rows
      pending.tries += 1
      requestCpr()
      return
    }
    cprPendingRef.current = null
  }

  const routeDragEvents = (events: SgrMouseEvent[]): void => {
    // Routing exists only under capture: without it the terminal never emits
    // these bytes, and injected ones must not arm queries or selections.
    if (!shouldCaptureMouse()) {
      cprPendingRef.current = null
      return
    }
    if (!composerActiveForMouse() || composerMouseRef.current === null) {
      cprPendingRef.current = null
      return
    }
    for (const event of events) {
      // SGR release always reports button 3 (no button encoded): any release
      // ends the gesture. Press/drag route left-button only; the rest is dead.
      if (event.kind === 'release') {
        const pending = cprPendingRef.current
        if (pending) {
          if (pending.events.length < 256) pending.events.push({ kind: 'release', x: event.x, y: event.y })
        } else {
          composerMouseRef.current?.release(event.x, event.y)
        }
        continue
      }
      if (event.button !== 0) continue
      if (event.kind === 'press') {
        if (offsetValid()) {
          composerMouseRef.current?.press(event.x, event.y)
          continue
        }
        const snapshot = snapshotCpr()
        if (!snapshot) continue
        const pending = cprPendingRef.current
        if (
          !pending
          || pending.caretX !== snapshot.caretX || pending.caretY !== snapshot.caretY
          || pending.rectX !== snapshot.rectX || pending.rectY !== snapshot.rectY
          || pending.cols !== snapshot.cols || pending.rows !== snapshot.rows
        ) {
          // A new gesture supersedes an unanswered one (stale caret/frame).
          cprPendingRef.current = { ...snapshot, tries: 0, events: [] }
          requestCpr()
        }
        cprPendingRef.current?.events.push({ kind: 'press', x: event.x, y: event.y })
      } else if (event.kind === 'drag') {
        const pending = cprPendingRef.current
        if (pending) {
          if (pending.events.length < 256) pending.events.push({ kind: 'move', x: event.x, y: event.y })
        } else {
          composerMouseRef.current?.move(event.x, event.y)
        }
      }
    }
    if ((cprPendingRef.current?.events.length ?? 0) > 256) cprPendingRef.current = null
  }

  useInput((inputValue, key) => {
    if (key.ctrl && inputValue === 'c') {
      // The mounted composer owns Ctrl+C (see `handleInterrupt`); overlays,
      // the approval gate and the question panel keep App-level behavior.
      if (overlay === null && state.awaitingApproval == null && !state.awaitingQuestion) return
      handleInterrupt()
      return
    }
    // Mouse reports do not count as intervening keyboard input.
    if (!containsMouseSequence(inputValue)) lastInterruptRef.current = null
    if (overlay || state.awaitingQuestion) {
      if (key.ctrl && inputValue === 'd') setOverlay(null)
      return
    }
    if (key.ctrl && inputValue === 'd') {
      exitRef.current(0)
      return
    }
    // Captured mouse routing: CPR replies anchor the
    // terminal→Ink translation; press/drag/release drive the composer's
    // constrained drag selection (frame chrome can never resolve). Wheel-only
    // chunks keep flowing to the scroll path below; anything else
    // mouse-shaped (fragments, legacy) stays swallowed below.
    const cprReplies = parseCprReplies(inputValue)
    if (cprReplies.length > 0) resolveCprReplies(cprReplies)
    const mouseEvents = parseSgrMouseEvents(inputValue)
    if (mouseEvents.some((event) => event.kind === 'press' || event.kind === 'drag' || event.kind === 'release')) {
      routeDragEvents(mouseEvents)
      return
    }
    // Scroll measured terminal rows; plain arrows remain composer editing keys.
    // Ink exposes SGR mouse events as text, which the composer also ignores.
    const wheel = parseWheelDelta(inputValue)
    if (wheel !== 0) {
      scrollBy(wheel)
      return
    }
    if (containsMouseSequence(inputValue)) return
    // Esc interrupts a running turn (long output streams), mirroring a
    // single Ctrl+C press but without touching the draft. Placed after the
    // mouse guards so SGR wheel bytes can never trigger it; overlays, the
    // approval gate and the question panel own Esc above. Idle Esc stays
    // with the Composer (completion dismiss).
    if (key.escape) {
      if (busyRef.current) controllerRef.current?.abort()
      return
    }
    if (key.pageUp || key.pageDown) {
      const step = pageStep(viewportRows)
      scrollBy(key.pageUp ? -step : step)
      return
    }
    if ((key.home || key.end) && key.ctrl) {
      setScrollTop(key.home ? 0 : null)
      return
    }
    if ((key.upArrow || key.downArrow) && key.ctrl && !key.meta) {
      scrollBy(key.upArrow ? -LINE_SCROLL_LINES : LINE_SCROLL_LINES)
      return
    }
    // opencode-style command palette (not during turns, approvals, or questions).
    if ((key.ctrl && inputValue === 'p') || inputValue === '\x10') {
      if (!busyRef.current && !state.awaitingApproval && !state.awaitingQuestion) setOverlay({ kind: 'palette' })
      return
    }
    // pi-style thinking expand/collapse (live, even mid-turn).
    if ((key.ctrl && inputValue === 't') || inputValue === '\x14') {
      dispatch({ type: 'toggle-thinking' })
      return
    }
    if ((key.ctrl && inputValue === 'o') || inputValue === '\x0f') {
      dispatch({ type: 'toggle-tools' })
      return
    }
    // Todo box collapse/expand. Ctrl+D stays reserved for exit, so the box
    // uses Ctrl+E (also shown in the box header and /help).
    if ((key.ctrl && inputValue === 'e') || inputValue === '\x05') {
      dispatch({ type: 'toggle-todos' })
      return
    }
    // Confirm/Cancel gate (design/janus-TUI-design.html): arrows move focus,
    // Enter confirms the focused action, Esc cancels. No y/n keys.
    if (state.awaitingApproval) {
      if (key.leftArrow) setApprovalChoice('confirm')
      else if (key.rightArrow) setApprovalChoice('cancel')
      else if (key.return) approvalResolveRef.current?.(approvalChoice === 'confirm')
      else if (key.escape) approvalResolveRef.current?.(false)
    }
  })

  const approval = state.awaitingApproval
  // Focused Confirm/Cancel button; resets to Confirm on every new request.
  const [approvalChoice, setApprovalChoice] = useState<'confirm' | 'cancel'>('confirm')
  useEffect(() => {
    if (approval) setApprovalChoice('confirm')
  }, [approval])
  // Header budgets: the statusline must NEVER wrap (a wrap perturbs the
  // measured scroll geometry and clips the top timeline rows). Static
  // chrome is 'janus │ ws: '(12) + 'model: '(7) + ' · appr: '(9) + ' │ ● '(5)
  // = 33 cells; the four labels split the remainder (model takes leftovers).
  const headerStatusFull = busy
    ? (approval ? `awaiting approval · ${approval.toolName}` : state.statusText || 'working…')
    : 'ready'
  const headerVarBudget = Math.max(12, discW - 33)
  const headerWsBudget = Math.max(4, Math.floor(headerVarBudget * 0.3))
  const headerStatusBudget = Math.max(4, Math.floor(headerVarBudget * 0.25))
  const headerApprBudget = Math.max(4, Math.floor(headerVarBudget * 0.15))
  const headerWs = truncateToWidth(state.workspaceLabel, headerWsBudget)
  const headerStatus = truncateToWidth(headerStatusFull, headerStatusBudget)
  const headerAppr = truncateToWidth(state.approvalLabel, headerApprBudget)
  const headerModel = truncateToWidth(
    state.modelLabel,
    Math.max(4, headerVarBudget - displayWidth(headerWs) - displayWidth(headerStatus) - displayWidth(headerAppr)),
  )
  const hidden = maxScroll - visibleTop
  const liveId = busy ? state.activeBlockId : undefined
  // Split bottom bar (design/janus-TUI-design.html): static key hints on the
  // left, live status meta on the right. Both sides are segmented so keys,
  // live state, token usage and the scroll badge each own a color; narrow
  // terminals fall back to tiered plain truncation (drop /help first, then
  // hard-truncate) so the pinned chrome never wraps.
  interface FootSeg { text: string; color: string }
  const footerConv = state.conversationLabel || undefined
  const footerStatus = state.statusText || undefined
  const footerUsage = state.sessionPromptTokens > 0 || state.sessionCompletionTokens > 0
    ? formatTokenUsage(state.sessionPromptTokens, state.sessionCompletionTokens)
    : ''
  const footerUp = hidden > 0 ? `↑${Math.floor(hidden)}` : ''
  const rightSegs: FootSeg[] = []
  if (footerConv) rightSegs.push({ text: footerConv, color: THEME.muted })
  if (footerStatus) rightSegs.push({ text: footerStatus, color: busy ? THEME.accent : THEME.muted })
  if (footerUsage) rightSegs.push({ text: footerUsage, color: THEME.body })
  if (footerUp) rightSegs.push({ text: footerUp, color: TUI_CHROME.yellow })
  const footerLeftFull = '[Enter] Send · [Shift+Enter] Line · [Ctrl+P] Cmds · /help'
  const footerLeftShort = '[Enter] Send · [Shift+Enter] Line · [Ctrl+P] Cmds'
  // Single source for the right-side order/shape (also unit-tested in store).
  const footerRightFull = buildFooterText({
    conversationLabel: footerConv,
    statusText: footerStatus,
    sessionPromptTokens: state.sessionPromptTokens,
    sessionCompletionTokens: state.sessionCompletionTokens,
    hiddenRows: hidden,
  })
  const footerFits = (left: string): boolean =>
    displayWidth(left) + (footerRightFull ? displayWidth(footerRightFull) + 2 : 0) <= discW
  const footerMode = footerFits(footerLeftFull) ? 'full' : footerFits(footerLeftShort) ? 'short' : 'truncated'
  const footerRight = truncateToWidth(footerRightFull, Math.max(0, discW - displayWidth(footerLeftFull) - 3))
  const footerLeft = truncateToWidth(footerLeftFull, Math.max(0, discW - displayWidth(footerRight) - (footerRight ? 3 : 0)))
  const renderFooterLeft = (withHelp: boolean): React.JSX.Element => (
    <Text color={THEME.muted}>
      <Text color={THEME.body}>[Enter]</Text> Send · <Text color={THEME.body}>[Shift+Enter]</Text> Line · <Text color={THEME.body}>[Ctrl+P]</Text> Cmds{withHelp ? (
        <> · <Text color={THEME.body}>/help</Text></>
      ) : null}
    </Text>
  )
  const renderFooterRight = (): React.JSX.Element => (
    <Text color={THEME.muted}>
      {rightSegs.map((seg, index) => (
        <React.Fragment key={index}>
          {index > 0 ? ' · ' : null}
          <Text color={seg.color}>{seg.text}</Text>
        </React.Fragment>
      ))}
    </Text>
  )

  const paletteItems: PaletteItem[] = [
    { id: 'connect', label: 'Connect / manage providers', hint: 'keys + test' },
    { id: 'status', label: 'Show status', hint: '/status' },
    { id: 'model', label: 'List / switch model', hint: '/model' },
    { id: 'effort', label: 'Show / switch reasoning effort', hint: '/effort' },
    { id: 'provider', label: 'List / switch provider', hint: '/provider' },
    { id: 'key', label: 'API key status', hint: '/key' },
    { id: 'approval', label: 'Approval mode', hint: '/approval' },
  ]

  return (
    // Ink's cursor protocol needs a trailing newline. Reserve its terminal row
    // so repaint and cursor-only updates share the same output origin.
    <Box flexDirection="column" paddingX={TUI_HORIZONTAL_PADDING} height={termHeight == null ? undefined : Math.max(1, termHeight - 1)}>
      {/* Seamless statusline (design/janus-TUI-design.html): no closed box,
          split left/right with a faint bottom rule that melts into the
          terminal. marginTop keeps it off the very first terminal row. */}
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text bold color={THEME.accent}>janus</Text>
            <Text color={THEME.muted}> │ ws: </Text>
            <Text color={THEME.body}>{headerWs}</Text>
          </Text>
          <Text>
            <Text color={THEME.muted}>model: </Text>
            <Text color={THEME.body}>{headerModel}</Text>
            <Text color={THEME.muted}> · appr: </Text>
            <Text color={THEME.body}>{headerAppr}</Text>
            <Text color={THEME.muted}> │ </Text>
            <Text color={busy ? THEME.accent : TUI_CHROME.green}>● </Text>
            <Text color={THEME.body}>{headerStatus}</Text>
          </Text>
        </Box>
        <Text color={TUI_CHROME.subtleBorder}>{'─'.repeat(Math.max(8, discW))}</Text>
      </Box>

      <Box ref={viewportRef} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" marginY={1}>
        {empty ? (
          <Box flexDirection="column" marginY={1}>
            <EmptyBanner />
            {noticeBlocks.map((block) => <TimelineRow key={block.id} block={block} width={discW} live={false} thinkingExpanded={state.thinkingExpanded} />)}
          </Box>
        ) : (
          <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-visibleTop}>
            {visibleBlocks.map((block) => <TimelineRow key={block.id} block={block} width={discW} live={block.id === liveId} thinkingExpanded={state.thinkingExpanded} toolsExpanded={state.toolsExpanded} />)}
            {busy ? <Activity text={approval ? `awaiting approval · ${approval.toolName}` : state.statusText || 'working…'} startedAt={state.turnStartedAt} />
              : state.turnEndedAt && state.turnStartedAt ? <Text color={THEME.muted}>{state.statusText || 'done'} · {duration(state.turnEndedAt - state.turnStartedAt)}{state.promptTokens || state.completionTokens ? ` · ${formatTokenUsage(state.promptTokens, state.completionTokens)}` : ''}</Text> : null}
          </Box>
        )}
      </Box>

      <Box flexShrink={0} flexDirection="column">
        <TodoStickyBar todos={state.todos} width={discW} expanded={state.todosExpanded} />
        {pending.length > 0 ? (
          <Text color={THEME.muted}>{truncateToWidth(`queued (${pending.length}): ${pending[0]?.replace(/\s+/g, ' ')}`, discW)}</Text>
        ) : null}
        {overlay?.kind === 'palette' ? (
          <CommandPalette
            items={paletteItems}
            onPick={(item) => {
              setOverlay(null)
              if (item.id === 'connect') setOverlay({ kind: 'connect', initial: {} })
              else void runCommand(item.id, [])
            }}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {overlay?.kind === 'connect' ? (
          <ConnectPanel
            session={sessionRef.current}
            initial={overlay.initial}
            testConnection={host.testConnection}
            notify={(line) => dispatch({ type: 'info', text: line })}
            warn={(line) => dispatch({ type: 'error', text: line })}
            onClose={() => {
              setOverlay(null)
              refreshContext()
            }}
          />
        ) : null}
        {overlay?.kind === 'approval' ? (
          <ApprovalPanel
            current={sessionRef.current.getApprovalMode()}
            onPick={(mode) => {
              sessionRef.current.setApprovalMode(mode)
              dispatch({
                type: 'info',
                text: mode === 'per-action'
                  ? 'approval: per-action (each write/create asks Confirm/Cancel)'
                  : 'approval: auto-run',
              })
              setOverlay(null)
              refreshContext()
            }}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {overlay?.kind === 'effort' ? (
          <EffortPanel
            current={sessionRef.current.getEffort()}
            onPick={(level) => {
              try {
                sessionRef.current.setEffort(level)
                const meta = effortMeta(level)
                dispatch({ type: 'info', text: `effort switched: ${level} — ${meta.hint} (${meta.detail})` })
              } catch (error) {
                dispatch({ type: 'error', text: error instanceof Error ? error.message : String(error) })
              }
              setOverlay(null)
              refreshContext()
            }}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {approval ? (
          <PanelFrame title={`! Approve ${approval.toolName} [${approval.actionRisk}]`} hint="← → move · Enter confirm · Esc cancel">
            <Text color={THEME.body}>
              [{approval.workspaceId}]{approval.summary ? ` ${approval.summary}` : ''}{approval.paths?.length ? ` (${approval.paths.join(', ')})` : ''}
            </Text>
            {approval.detail ? approval.detail.split('\n').slice(0, 8).map((line, index) => (
              <Text key={index} color={THEME.body}>  {line || ' '}</Text>
            )) : null}
            {approval.detail && approval.detail.split('\n').length > 8 ? (
              <Text color={THEME.muted}>  … ({approval.detail.split('\n').length - 8} more)</Text>
            ) : null}
            <Box flexDirection="row" gap={2} marginTop={1}>
              <Text
                backgroundColor={approvalChoice === 'confirm' ? TUI_CHROME.green : undefined}
                color={approvalChoice === 'confirm' ? 'black' : THEME.muted}
                bold={approvalChoice === 'confirm'}
              >
                {approvalChoice === 'confirm' ? '▸ Confirm' : '  Confirm'}
              </Text>
              <Text
                backgroundColor={approvalChoice === 'cancel' ? TUI_CHROME.red : undefined}
                color={approvalChoice === 'cancel' ? 'black' : THEME.muted}
                bold={approvalChoice === 'cancel'}
              >
                {approvalChoice === 'cancel' ? '▸ Cancel' : '  Cancel'}
              </Text>
            </Box>
          </PanelFrame>
        ) : state.awaitingQuestion ? (
          <QuestionPanel
            view={state.awaitingQuestion}
            onResolve={(answer) => questionResolveRef.current?.(answer)}
          />
        ) : (
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submit}
            disabled={approval != null || overlay != null || state.awaitingQuestion != null}
            busy={busy}
            history={inputHistory}
            historyIndex={historyIndex}
            historyDraft={historyDraft}
            onHistoryRecall={handleHistoryRecall}
            onInterrupt={handleInterrupt}
            onSelectionAction={handleSelectionAction}
            frameRectRef={frameRectRef}
            terminalOffsetRef={terminalOffsetRef}
            mouseControlRef={composerMouseRef}
          />
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        <Text color={TUI_CHROME.subtleBorder}>{'─'.repeat(Math.max(8, discW))}</Text>
        <Box justifyContent="space-between">
          {footerMode === 'full' ? renderFooterLeft(true)
            : footerMode === 'short' ? renderFooterLeft(false)
              : <Text color={THEME.muted}>{footerLeft}</Text>}
          {footerMode === 'truncated'
            ? (footerRight ? <Text color={THEME.muted}>{footerRight}</Text> : null)
            : (footerRightFull ? renderFooterRight() : null)}
        </Box>
      </Box>
    </Box>
  )
}
