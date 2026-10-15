// Note: Note tools are shared engineering capabilities — see .agents/notes/harness/storage/history/workflowx-runtime.md
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { NoteChatEditor, NoteService, noteService, previewHarnessInit, applyHarnessInit, type HarnessInitPlan } from '@janus-agent/harness-node'
import { type ToolDefinition, type ToolRegistry } from '@janus-agent/agent-core'
export const NOTE_TOOL_DEFINITIONS = [
  { name: 'note.list', actionRisk: 'read', description: 'Find project Notes by title or content. Optional relatedTo Note URI returns explicit relations and Markdown mentions in either direction, preserving their types and unresolved references. No manual canvas selection is needed.', inputSchema: { type: 'object', properties: { kind: {type:'string'}, module: {type:'string'}, moduleState: {type:'string'}, query: { type: 'string' }, relatedTo: { type: 'string' } }, additionalProperties: false } },
  { name: 'note.read', actionRisk: 'read', description: 'Read Note source with its exact expectedHash. Large Notes are paged: follow nextOffset with offset and expectedHash to continue the same version. Restart at offset zero if the source changed. Read required sections before editing.', inputSchema: { type: 'object', properties: { uri: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 500, maximum: 12000 }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Source hash from the prior page or context. A mismatch rejects the page.' } }, required: ['uri'], additionalProperties: false } },
  { name: 'note.write', actionRisk: 'write', description: 'Apply requested Note changes directly in one transaction (1-16 operations). Maintain authorized module documents in place. Create only for a distinct topic; move with relativePath, convert kind, or delete obsolete content while repairing references. Create requires kind/title; update and delete require uri and exact expectedHash from a successful read through the same host. sections maps existing level-two heading names to replacement Markdown bodies, not whole documents or an array; preserve unrelated sections. Example update: {type:"update",uri:"note://repo-uuid/note-uuid",expectedHash:"sha256 from read",sections:{Design:"New design body"}}. Main Agent owns Task prose; do not change execution metadata or claim completion.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 }, operations: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
      type: { type: 'string', enum: ['create', 'update', 'delete'] }, uri: { type: 'string' }, expectedHash: { type: 'string' }, kind: { type: 'string', enum: ['module', 'note', 'idea', 'requirement', 'decision', 'task'] }, title: { type: 'string' },
      module: {type:'string'}, moduleState:{type:'string',enum:['planned','partial','implemented','retired']}, relativePath:{type:'string'},
      work: { type: 'object', description: 'Task contract: scope [{repoId, paths}], acceptanceRefs [{uri, criterionId}], verification [{id, kind: command, required, repoId, program, args, cwd}]. Include review: self or independent. Required for an executable accepted task.' }, relations: { type: 'array', items: { type: 'object' } }, codeRefs: { type: 'array', items: { type: 'object' } }, sections: { type: 'object', description: 'Map of level-two heading names to replacement bodies. Omit unchanged sections. Do not pass raw document Markdown.', additionalProperties: { type: 'string', maxLength: 200000 } }, tags: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 100 } }, parent: { type: ['string', 'null'] }, lifecycle: { type: 'string', enum: ['draft', 'proposed', 'accepted', 'archived', 'rejected', 'implemented'] },
    }, required: ['type'], additionalProperties: false } } }, required: ['reason', 'operations'], additionalProperties: false } },
] as ToolDefinition[]

export function registerNoteTools(registry: ToolRegistry, service: NoteService = noteService, editor: NoteChatEditor = new NoteChatEditor(service)): void {
  for (const definition of NOTE_TOOL_DEFINITIONS) {
    if (registry.get(definition.name)) continue
    registry.register({ ...definition, inputSchema: { ...definition.inputSchema,
      properties: { ...definition.inputSchema.properties, workspaceId: { type: 'string' } },
      required: ['workspaceId', ...(definition.inputSchema.required ?? [])] },
      execute: async (input, context) => {
        if (input.workspaceId !== context.workspaceId) throw new Error('Note workspace does not match the active session')
        context.signal.throwIfAborted()
        const { workspaceId: _workspaceId, ...args } = input
        if (definition.name === 'note.list') return editor.list(context.workspaceRoot, z.string().max(1000).parse(args.query ?? ''), z.string().optional().parse(args.relatedTo), {kind:z.string().optional().parse(args.kind),module:z.string().optional().parse(args.module),moduleState:z.string().optional().parse(args.moduleState)})
        if (definition.name === 'note.read') {
          return editor.readPage(context.workspaceRoot, z.string().parse(args.uri), args)
        }
        // The runtime already applied the caller's write policy; no second approval mechanism.
        const result = await editor.write(context.workspaceRoot, 'agentx', randomUUID(), args, true, context.signal)
        return result ? { status: 'applied', id: result.id, txId: result.txId, files: result.files.map(({ uri, title }) => ({ uri, title })) } : { status: 'unchanged' }
      },
    })
  }
  const previews = new Map<string, HarnessInitPlan>()
  if (!registry.get('note.init')) registry.register({
    name: 'note.init', actionRisk: 'create', description: 'Preview explicit minimal WorkflowX initialization. Call without previewId to see the files; apply only by returning that previewId after the user authorizes initialization. Existing identity is never overwritten.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, name: { type: 'string' }, previewId: { type: 'string' } }, required: ['workspaceId'], additionalProperties: false },
    execute: async (input, context) => {
      if (input.workspaceId !== context.workspaceId) throw new Error('Note workspace does not match the active session')
      context.signal.throwIfAborted()
      if (typeof input.previewId === 'string') {
        const preview = previews.get(input.previewId)
        if (!preview || preview.root !== context.workspaceRoot) throw new Error('Initialization preview is unavailable for this workspace')
        const result = await applyHarnessInit(preview)
        previews.delete(input.previewId)
        await service.rescan(context.workspaceRoot)
        return result
      }
      const preview = await previewHarnessInit(context.workspaceRoot, typeof input.name === 'string' ? input.name : undefined)
      const previewId = randomUUID()
      if (previews.size >= 32) previews.delete(previews.keys().next().value!)
      previews.set(previewId, preview)
      return { previewId, ...preview }
    },
  })
}
