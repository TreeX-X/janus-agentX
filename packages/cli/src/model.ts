/**
 * @file Local model transport for the janus CLI.
 * OpenAI-compatible endpoint (`JANUS_BASE_URL`, default api.openai.com)
 * via `@ai-sdk/openai` and the reasoning-capable CLI stream adapter.
 * Construction is lazy: no network happens here.
 */
import { createOpenAI } from '@ai-sdk/openai'

export interface ChatModelConfig {
  baseURL: string
  apiKey: string
  modelId: string
}

/** Opaque handle for `ChatTurnPorts.model.resolve().model`. */
export function createChatModel(config: ChatModelConfig): unknown {
  const provider = createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })
  return provider(config.modelId)
}
