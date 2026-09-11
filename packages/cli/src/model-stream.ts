import { streamText, type LanguageModel, type ModelMessage, type Tool } from 'ai-stream'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import { effortProviderOptions, normalizeEffort } from './effort.js'

type LegacyPart = Record<string, unknown>
const toolMetadata = new WeakMap<object, Map<string, unknown>>()

/** Keep the core's transport contract while using a reasoning-capable SDK. */
export const streamChatModel: ChatTurnPorts['streamTextFn'] = async (options) => {
  const model = options.model as object
  let metadata = toolMetadata.get(model)
  if (!metadata) {
    metadata = new Map()
    toolMetadata.set(model, metadata)
  }
  const messages = (options.messages as Array<{ role: string; content: string | LegacyPart[] }>).map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => {
      if (part.type === 'tool-call') {
        const { args, ...rest } = part
        return { ...rest, input: args, providerOptions: metadata.get(String(part.toolCallId)) }
      }
      if (part.type === 'tool-result') {
        const { result, ...rest } = part
        return { ...rest, output: typeof result === 'string' ? { type: 'text', value: result } : { type: 'json', value: result ?? null } }
      }
      return part
    }) : message.content,
  })) as ModelMessage[]
  const tools = Object.fromEntries(Object.entries((options.tools ?? {}) as Record<string, { description?: string; parameters: Tool['inputSchema'] }>)
    .map(([name, tool]) => [name, { description: tool.description, inputSchema: tool.parameters }]))
  const effort = normalizeEffort((options as { effort?: unknown }).effort)
  const effortOptions = effort ? effortProviderOptions(effort) : undefined
  const result = streamText({
    model: options.model as LanguageModel,
    messages,
    allowSystemInMessages: true, // The core assembles ordered system context and recovery messages.
    tools,
    abortSignal: options.abortSignal as AbortSignal,
    maxRetries: 0, // The agent loop owns the retry budget.
    onError: () => undefined, // Errors are rendered through the event stream, never console.
    ...(effortOptions ? { providerOptions: effortOptions.providerOptions } : {}),
  })
  return {
    get textStream() { return result.textStream },
    fullStream: (async function* () {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
          case 'reasoning-delta':
            yield { type: part.type, textDelta: part.text }
            break
          case 'tool-input-start':
            yield { type: 'tool-call-streaming-start', toolCallId: part.id, toolName: part.toolName }
            break
          case 'tool-input-delta':
            yield { type: 'tool-call-delta', toolCallId: part.id, argsTextDelta: part.delta }
            break
          case 'tool-call':
            if (part.providerMetadata) {
              metadata.set(part.toolCallId, part.providerMetadata)
              if (metadata.size > 256) metadata.delete(metadata.keys().next().value!)
            }
            yield { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, args: part.input }
            break
          case 'finish':
            yield { type: 'finish', finishReason: part.finishReason, usage: {
              promptTokens: part.totalUsage.inputTokens,
              completionTokens: part.totalUsage.outputTokens,
            } }
            break
          case 'error':
            yield { type: 'error', error: part.error }
            break
        }
      }
    })(),
  }
}
