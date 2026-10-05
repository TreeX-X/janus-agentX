import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'wait', inputSchema: { type: 'object', additionalProperties: false } },
] }))
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'wait') await new Promise(resolve => {
    const timer = setTimeout(resolve, 30000)
    extra.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  return { content: [{ type: 'text', text: request.params.arguments?.text ?? 'done' }] }
})
await server.connect(new StdioServerTransport())
