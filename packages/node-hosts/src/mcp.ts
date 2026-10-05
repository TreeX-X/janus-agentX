// Note: MCP connections and tool adaptation are owned by agentX — see .agents/notes/2026-10-05-workflowx-runtime--ac75da81.md
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { toolSchemaToZod, type ToolRegistry, type ToolInputSchema } from '@janus-agent/agent-core'

const configSchema = z.object({ mcpServers: z.record(z.union([
  z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string()).optional(), cwd: z.string().optional(), disabled: z.boolean().optional() }).strict(),
  z.object({ url: z.string().url(), headers: z.record(z.string()).optional(), disabled: z.boolean().optional() }).strict(),
])) }).strict()
export type McpConfiguration = z.input<typeof configSchema>
export const defaultMcpConfigPath = () => join(homedir(), '.janus', 'mcp.json')

export class McpToolManager {
  private connections: Client[] = []
  private names: string[] = []
  readonly status: Array<{ server: string; state: 'connected' | 'disabled' | 'failed'; tools: number }> = []
  constructor(private registry: ToolRegistry) {}

  async connect(configuration: McpConfiguration): Promise<void> {
    const config = configSchema.parse(configuration)
    for (const [server, specification] of Object.entries(config.mcpServers)) {
      if (specification.disabled) { this.status.push({ server, state: 'disabled', tools: 0 }); continue }
      const client = new Client({ name: 'janus-agentx', version: '0.1.0' })
      let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined
      const registered: string[] = []
      try {
        transport = 'command' in specification
          ? new StdioClientTransport({ command: specification.command, args: specification.args, env: { ...getDefaultEnvironment(), ...specification.env }, cwd: specification.cwd, stderr: 'pipe' })
          : new StreamableHTTPClientTransport(new URL(specification.url), { requestInit: { headers: specification.headers } })
        if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
        await client.connect(transport, { timeout: 10000 })
        let cursor: string | undefined
        const cursors = new Set<string>()
        let count = 0
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 })
          for (const tool of page.tools) {
            if (++count > 256) throw new Error('MCP tool limit exceeded')
            const schema = tool.inputSchema as ToolInputSchema
            toolSchemaToZod(schema)
            const suffix = createHash('sha256').update(`${server}\0${tool.name}`).digest('hex').slice(0, 12)
            const name = `mcp.${server.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}.${tool.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}_${suffix}`
            this.registry.register({ name, description: `[MCP ${server}] ${tool.description ?? tool.name}`,
              // Server annotations do not grant authority; calls always retain the host's execution policy.
              actionRisk: 'network', inputSchema: { type: 'object', properties: {
                workspaceId: { type: 'string' }, arguments: schema,
              }, required: ['workspaceId', 'arguments'], additionalProperties: false },
              execute: async (input, context) => {
                if (input.workspaceId !== context.workspaceId) throw new Error('MCP workspace does not match the session')
                context.signal.throwIfAborted()
                const result = await client.callTool({ name: tool.name, arguments: input.arguments as Record<string, unknown> }, undefined, { signal: context.signal, timeout: 60000 })
                if (result.isError) throw new Error(`MCP tool failed: ${server}/${tool.name}`)
                return result
              },
            })
            registered.push(name)
          }
          cursor = page.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('MCP returned a repeated cursor')
          if (cursor) cursors.add(cursor)
        } while (cursor)
        this.names.push(...registered)
        this.connections.push(client)
        this.status.push({ server, state: 'connected', tools: registered.length })
      } catch {
        for (const name of registered) this.registry.unregister(name)
        await client.close().catch(() => undefined)
        await transport?.close().catch(() => undefined)
        this.status.push({ server, state: 'failed', tools: 0 })
      }
    }
  }

  async close(): Promise<void> {
    for (const name of this.names.splice(0)) this.registry.unregister(name)
    await Promise.all(this.connections.splice(0).map(client => client.close().catch(() => undefined)))
  }
}

/** Read explicit user-owned configuration, never executable configuration discovered in repository source. */
export async function connectConfiguredMcp(registry: ToolRegistry, path = defaultMcpConfigPath()): Promise<McpToolManager> {
  const manager = new McpToolManager(registry)
  try { await manager.connect(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') manager.status.push({ server: 'configuration', state: 'failed', tools: 0 })
  }
  if (!registry.get('mcp.status')) registry.register({
    name: 'mcp.status', description: 'Inspect configured MCP server availability. Contains no credentials.', actionRisk: 'read',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, additionalProperties: false },
    execute: () => ({ servers: manager.status.map(row => ({ ...row })) }),
  })
  return manager
}
