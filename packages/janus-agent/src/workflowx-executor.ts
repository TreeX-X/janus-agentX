// Note: both hosts use the same WorkflowX task executor — see .agents/notes/harness/storage/history/workflowx-runtime.md
import { randomUUID } from 'node:crypto'
import { collectTaskBaseline, readTaskResult } from '@janus-agent/harness-node'
import type { HarnessMode } from '@janus-agent/harness-core'
import { ChatSessionRuntime } from '@janus-agent/chat-core'
import { createToolPreview } from '@janus-agent/agent-core'
import type { ChatTurnPorts, AgentSessionDescriptor } from './ports.js'
import { runChatTurn, type ChatTurnRequest } from './orchestrator/chat-turn.js'
import { dispatchRun, startRun, pauseRun } from './harness/dispatcher.js'
import { executeTaskExecution, type TaskTurnContext, type TaskVerificationPorts } from './harness/task-execution.js'

export async function executeWorkflowXTask(input: {
  taskUri: string; mode: HarnessMode; parent: AgentSessionDescriptor; request: ChatTurnRequest
  ports: ChatTurnPorts; signal?: AbortSignal
}) {
  const { ports, parent, request, signal } = input
  signal?.throwIfAborted()
  if (!ports.sessions.forkSession || !ports.sessions.closeSession) throw new Error('CAPABILITY_UNAVAILABLE: WorkflowX requires isolated child sessions')
  const baseline = await collectTaskBaseline(parent.workspaceRoot, input.taskUri)
  if (!baseline.ok) throw new Error(baseline.problems.map(item => `${item.code}: ${item.message}`).join('\n'))
  const dispatched = await dispatchRun(parent.workspaceRoot, {
    taskUri: baseline.baseline.taskUri, mode: input.mode, taskContractHash: baseline.baseline.taskContractHash,
    inputs: baseline.baseline.inputs, closeout: 'commit-required', maxAutoRepairs: input.mode === 'xflow' ? 1 : 0,
    executor: 'internal',
  })
  if (!dispatched.ok) throw new Error(dispatched.errors.map(item => item.message).join('\n'))
  const owner = `${request.callerId ?? 'janus-agent'}:workflowx:${randomUUID()}`
  const runId = dispatched.data.runId
  const started = await startRun(parent.workspaceRoot, runId, owner, {
    baselineValid: true, dependenciesReady: true, authorization: { by: request.callerId ?? 'janus-agent' },
  })
  if (!started.ok) throw new Error(started.errors.map(item => item.message).join('\n'))
  const token = started.run!.lease!.token
  const child = async <T>(action: (session: AgentSessionDescriptor) => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    const session = await ports.sessions.forkSession!(parent.sessionId, request.callerId ?? 'janus-agent')
    const cancel = () => { void ports.sessions.closeSession!(session.sessionId).catch(() => undefined) }
    signal?.addEventListener('abort', cancel, { once: true })
    try { signal?.throwIfAborted(); return await action(session) }
    finally { signal?.removeEventListener('abort', cancel); await ports.sessions.closeSession!(session.sessionId) }
  }
  const turn = (context: TaskTurnContext, prompt: string) => child(session => runChatTurn({
    ...request, ...context, requestId: randomUUID(), messages: [{ role: 'user', content: prompt }],
    toolAllowlist: request.toolAllowlist ? context.toolAllowlist?.filter(name => request.toolAllowlist!.some(allowed => allowed.replace(/[._-]/g, '').toLowerCase() === name.replace(/[._-]/g, '').toLowerCase())) ?? request.toolAllowlist : context.toolAllowlist,
    toolGate: async call => await request.toolGate?.(call) ?? await context.toolGate?.(call),
    conversationId: `${context.conversationId}-${randomUUID()}`, chatSession: new ChatSessionRuntime(),
    workspaceResources: [{ workspaceId: parent.workspaceId, workspacePath: parent.workspaceRoot,
      workspaceName: parent.workspaceId, agentSessionId: session.sessionId }],
    toolTraces: [], steeringPort: undefined,
  }, ports, {}, signal))
  const review: NonNullable<TaskVerificationPorts['review']> = async reviewInput => {
    const result = await turn(reviewInput.turn, [
      `${reviewInput.kind === 'independent' ? 'Independent evaluation' : 'Implementor self-review'} of the pinned task. Read relevant files.`,
      'Return a JSON object with review and coverage. Cite only passing check IDs that demonstrate each acceptance criterion. Never approve failing or insufficient evidence.',
      JSON.stringify({ manifest: reviewInput.manifest, checks: reviewInput.checks, criteria: reviewInput.criteria }),
      JSON.stringify({ review: { kind: reviewInput.kind, verdict: 'approved|needs-fix|blocked', reviewedManifestHash: reviewInput.manifestHash, actor: reviewInput.actor, summary: 'concrete findings' }, coverage: reviewInput.criteria }),
    ].join('\n'))
    if (result.cancelled || result.toolTraces.some(trace => trace.status !== 'completed')) throw new Error('NOT_READY: review did not complete')
    try { return JSON.parse(result.text) } catch { throw new Error('NOT_READY: reviewer did not return structured evidence') }
  }
  try {
    const result = await executeTaskExecution(parent.workspaceRoot, runId, token, {
      implement: context => turn(context, 'Implement the pinned task in the declared scope with engineeringX and specX, then self-review. Return Change Summary + Note draft with implementation facts, actual checks and unresolved issues for Main Agent integration. Include an entry reverse reference to the owning Note. All Task files are read-only: never edit metadata, prose, timestamps or paths. Preserve unrelated work; the executor owns formal execution records.'),
      review, independentReview: review,
      command: step => child(async session => {
        const input = { workspaceId: parent.workspaceId, program: step.program, args: step.args, cwd: step.cwd, background: false }
        const result = await ports.tools.executeFunctionCall({ sessionId: session.sessionId, call: {
          toolName: 'command.run', input, preview: createToolPreview('command.run', input),
          source: 'planner', evidenceConfidence: 'high',
        } }, request.callerId ?? 'janus-agent')
        const output = result.output as { ok?: boolean; exitCode?: number; timedOut?: boolean; stdout?: string; stderr?: string } | undefined
        return { ok: result.status === 'completed' && output?.ok === true, exitCode: output?.exitCode,
          timedOut: output?.timedOut, summary: [result.error, output?.stdout, output?.stderr].filter(Boolean).join('\n') || result.status }
      }),
    }, signal)
    const formal = await readTaskResult(parent.workspaceRoot, input.taskUri, { closeout: true })
    return { runId, mode: input.mode, ...result, closeout: formal.closeout,
      message: result.completed ? 'Verification completed. Commit scoped code, the task Note and its evidence together; use workflow_execute with action status to verify landing. Verification alone does not mean committed.' : 'Verification is incomplete; inspect the errors and receipt.' }
  } catch (error) {
    await pauseRun(parent.workspaceRoot, runId, token)
    throw error
  }
}
