/**
 * @file Local model transport for the janus CLI.
 * OpenAI-compatible endpoint (`JANUS_BASE_URL`, default api.openai.com)
 * via `@ai-sdk/openai`, wrapped for the pinned `ai@3.4.33` core.
 * Construction is lazy: no network happens here.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { withAiSdkV1StreamCompatibility } from './model-compat.js'

export interface ChatModelConfig {
  baseURL: string
  apiKey: string
  modelId: string
}

/** Opaque handle for `ChatTurnPorts.model.resolve().model`. */
export function createChatModel(config: ChatModelConfig): unknown {
  const provider = createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })
  // Mirrors JanusX llm-core: the spec-v3 model is erased to any at the seam;
  // the shim normalizes it back to the v1 shape ai-3 streamText speaks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withAiSdkV1StreamCompatibility(provider(config.modelId) as any)
}
