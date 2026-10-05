import { toolSchemaToZod } from './tool-schema'
import type { ToolCall, ToolDefinition, ToolInputSchema } from '../../../shared/ipc/agent-runtime'
import { createToolManifests, type ToolManifest } from './tool-manifest'

export interface RegisteredTool extends ToolDefinition {
  execute: (input: Record<string, unknown>, context: { workspaceId: string; workspaceRoot: string; signal: AbortSignal }) => Promise<unknown> | unknown
}

const SUPPORTED_ACTION_RISKS = new Set([
  'inspect', 'list', 'stat', 'read', 'write', 'create', 'config-apply', 'run', 'restore', 'delete', 'external-command', 'network',
])
function validSchema(schema: ToolInputSchema): boolean {
  try { if (schema?.type !== 'object') return false; toolSchemaToZod(schema); return true } catch { return false }
}
export function validateToolInput(schema: ToolInputSchema, input: unknown): input is Record<string, unknown> {
  try { return schema?.type === 'object' && toolSchemaToZod(schema).safeParse(input).success } catch { return false }
}
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  register(tool: RegisteredTool): void {
    if (!tool.name || !SUPPORTED_ACTION_RISKS.has(tool.actionRisk) || !validSchema(tool.inputSchema) || typeof tool.execute !== 'function') throw new Error('Invalid tool definition')
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    createToolManifests([...this.list(), tool])
    this.tools.set(tool.name, tool)
  }
  get(name: string): RegisteredTool | undefined { return this.tools.get(name) }
  unregister(name: string): void { this.tools.delete(name) }
  list(): ToolDefinition[] { return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition) }
  listManifests(): ToolManifest[] { return createToolManifests(this.list()) }
  validateCall(call: ToolCall): RegisteredTool {
    const tool = this.tools.get(call.toolName)
    if (!tool) throw new Error(`Unknown tool: ${call.toolName}`)
    if (!validateToolInput(tool.inputSchema, call.input)) throw new Error(`Invalid input for tool: ${call.toolName}`)
    return tool
  }
}
