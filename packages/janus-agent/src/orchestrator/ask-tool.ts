/**
 * @file Local `ask_user` tool (opencode `question` parity).
 * @description Workspace-independent, approval-free confirmation tool. The
 * model asks 1-4 questions with options; the host renders them, the user
 * answers or cancels the whole call, and the answer returns as the tool
 * result so the turn continues. Validation failures return `isError`
 * content so the model self-heals (same contract as `todo_write`).
 */
import { z } from 'zod'
import {
  ASKUSER_TOOL_DESCRIPTION,
  ASKUSER_TOOL_NAME,
  ASK_MAX_DESCRIPTION_CHARS,
  ASK_MAX_HEADER_CHARS,
  ASK_MAX_LABEL_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ASK_MAX_QUESTION_CHARS,
  ASK_MIN_OPTIONS,
  askCancelledContent,
  formatAskHistoryNote,
  formatAskResultContent,
  validateAskUserRequest,
  type AskUserAnswer,
  type AskUserRequest,
} from '@janus-agent/chat-core'
import type { JanusAgentTool } from '@janus-agent/agent-core'
import type { AskUserPortAnswer, QuestionPort } from '../ports.js'

const askOptionSchema = z.object({
  label: z.string().min(1).max(ASK_MAX_LABEL_CHARS),
  description: z.string().max(ASK_MAX_DESCRIPTION_CHARS).optional(),
})

const askQuestionSchema = z.object({
  question: z.string().min(1).max(ASK_MAX_QUESTION_CHARS),
  header: z.string().min(1).max(ASK_MAX_HEADER_CHARS),
  options: z.array(askOptionSchema).min(ASK_MIN_OPTIONS).max(ASK_MAX_OPTIONS),
  multiple: z.boolean().optional(),
})

export const askUserParameters = z.object({
  questions: z.array(askQuestionSchema).min(1).max(ASK_MAX_QUESTIONS),
  allowCustom: z.boolean().optional(),
})

export { ASKUSER_TOOL_NAME }

export interface AskToolHooks {
  /** Host question UI. Undefined = non-interactive host (deny). */
  question?: QuestionPort
  /** Fired before awaiting the user (drives `question_requested` events). */
  onRequest?: (request: AskUserRequest, callId: string) => void
  /** Fired after the user resolves (drives `question_resolved` events). */
  onResolved?: (answer: AskUserAnswer, callId: string) => void
}

/** Vercel-style definition for the model-facing `tools` map. */
export function createAskVercelTool(_hooks: AskToolHooks) {
  return {
    description: ASKUSER_TOOL_DESCRIPTION,
    parameters: askUserParameters,
    execute: async () => {
      // Never executed model-side; the loop tool below owns execution.
      // Present only so the model sees description + parameters.
      return 'ask_user resolves through the host question UI.'
    },
  }
}

function toPortAnswer(answer: AskUserAnswer): AskUserPortAnswer {
  return answer
}

/**
 * Loop-executed tool: validates, blocks on the host UI, and returns the
 * answer as content. Cancellation (user cancel, abort, missing UI, host
 * throw) always resolves to an `isError` cancel result — never throws —
 * so the turn continues with safest-default guidance.
 */
export function createAskLoopTool(hooks: AskToolHooks): JanusAgentTool {
  return {
    name: ASKUSER_TOOL_NAME,
    executionMode: 'sequential',
    execute: async (call, signal) => {
      if (signal.aborted) {
        const cancelled: AskUserAnswer = { status: 'cancelled' }
        hooks.onResolved?.(cancelled, call.id)
        return { content: askCancelledContent(), isError: true, details: { askUser: cancelled } }
      }
      const args = (call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : {}) as { questions?: unknown; allowCustom?: unknown }
      const parsed = askUserParameters.safeParse({ questions: args.questions, allowCustom: args.allowCustom })
      if (!parsed.success) {
        return { content: `Invalid ask_user arguments: ${parsed.error.issues[0]?.message ?? 'expected {questions: [{question, header, options, multiple}]}'}. Ask 1-4 questions with 2-6 options each.`, isError: true }
      }
      const validated = validateAskUserRequest({ questions: parsed.data.questions, allowCustom: parsed.data.allowCustom })
      if (!validated.ok) {
        return { content: `Invalid ask_user arguments: ${validated.error}`, isError: true }
      }
      const request = validated.request
      hooks.onRequest?.(request, call.id)
      let answer: AskUserAnswer
      try {
        if (signal.aborted) {
          answer = { status: 'cancelled' }
        } else if (!hooks.question) {
          return { content: 'ask_user unavailable in this host (non-interactive). Proceed with best-effort defaults and state assumptions explicitly.', isError: true }
        } else {
          const portAnswer = await hooks.question.askUser(
            {
              questions: request.questions.map((question) => ({
                question: question.question,
                header: question.header,
                options: question.options.map((option) => ({ ...option })),
                multiple: question.multiple,
              })),
              allowCustom: request.allowCustom,
              callId: call.id,
            },
            signal,
          )
          answer = toPortAnswer(portAnswer)
        }
      } catch {
        answer = { status: 'cancelled' }
      }
      hooks.onResolved?.(answer, call.id)
      if (answer.status !== 'answered') {
        return { content: askCancelledContent(), isError: true, details: { askUser: answer } }
      }
      const note = formatAskHistoryNote(answer)
      return {
        content: formatAskResultContent(answer),
        details: { askUser: answer, ...(note ? { historyNote: note } : {}) },
      }
    },
  }
}
