/**
 * @file Minimal structural model types for chat-core contracts.
 * @description The shell's full provider/model catalog types live in
 * @janusx/llm-core. chat-core only needs these shapes for context budgeting
 * and the LlmAPI surface, so it declares them structurally and stays free of
 * the `ai` SDK dependency. Hosts pass their own objects; excess fields are
 * ignored by the core.
 */
export interface ProviderSettings {
  id: string
  modelId?: string
  [key: string]: unknown
}

export interface ModelInfo {
  id: string
  supportsFunctionCalling?: boolean
  contextWindow?: number
  maxOutputTokens?: number
  [key: string]: unknown
}

export interface ModelCatalogSnapshot {
  models: ModelInfo[]
  [key: string]: unknown
}

export interface ModelCatalogRefreshResult {
  success: boolean
  [key: string]: unknown
}
