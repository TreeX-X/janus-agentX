/**
 * @file Multi-conversation registry (framework-agnostic: no Electron/React/Ink).
 * @description Mirrors the JanusX `useJanusChat` registry semantics —
 * per-conversation messages + tool traces + in-memory `ChatSessionRuntime`
 * with one active id — behind a pluggable `ConversationStorePort`. The CLI
 * wires the file store (`~/.janus/history/<id>.jsonl`); JanusX keeps its
 * `janusChat` IPC and can adapt this registry later without touching turns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ChatSessionRuntime, type ChatToolTraceEntry } from '@janus-agent/chat-core'

export const DEFAULT_CONVERSATION_TITLE = 'New conversation'
export const MAX_TITLE_CHARS = 80

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface PersistedConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: PersistedMessage[]
  toolTraces: ChatToolTraceEntry[]
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  turnCount: number
  active: boolean
}

export interface ConversationStorePort {
  list(): Promise<PersistedConversation[]>
  save(conversation: PersistedConversation): Promise<void>
  remove(id: string): Promise<void>
}

function sanitizeMessages(value: unknown): PersistedMessage[] {
  if (!Array.isArray(value)) return []
  return (value as Array<Record<string, unknown>>)
    .filter((message) =>
      (message.role === 'user' || message.role === 'assistant' || message.role === 'system')
      && typeof message.content === 'string')
    .map((message) => ({ role: message.role as PersistedMessage['role'], content: message.content as string }))
}

function sanitizeConversation(value: unknown): PersistedConversation | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record.id !== 'string' || !record.id) return null
  return {
    id: record.id,
    title: typeof record.title === 'string' && record.title ? record.title : DEFAULT_CONVERSATION_TITLE,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    messages: sanitizeMessages(record.messages),
    toolTraces: Array.isArray(record.toolTraces) ? record.toolTraces as ChatToolTraceEntry[] : [],
  }
}

export function memoryConversationStore(seed: PersistedConversation[] = []): ConversationStorePort {
  const records = new Map<string, PersistedConversation>(
    seed.map((conversation) => [conversation.id, structuredClone(conversation)]),
  )
  return {
    list: async () => [...records.values()].map((conversation) => structuredClone(conversation)),
    save: async (conversation) => { records.set(conversation.id, structuredClone(conversation)) },
    remove: async (id) => { records.delete(id) },
  }
}

export function defaultHistoryDir(): string {
  return join(homedir(), '.janus', 'history')
}

export function fileConversationStore(
  dir: string = defaultHistoryDir(),
  onError?: (error: unknown, operation: 'list' | 'save' | 'remove') => void,
): ConversationStorePort {
  const fileFor = (id: string): string => join(dir, `${id}.jsonl`)
  return {
    list: async () => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        onError?.(error, 'list')
        return []
      }
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
      } catch (error) {
        onError?.(error, 'list')
        return []
      }
      const conversations: PersistedConversation[] = []
      for (const file of files) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
          const sanitized = sanitizeConversation(parsed)
          if (sanitized) conversations.push(sanitized)
        } catch (error) {
          onError?.(error, 'list')
        }
      }
      return conversations
    },
    save: async (conversation) => {
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(fileFor(conversation.id), `${JSON.stringify(conversation)}\n`, 'utf8')
      } catch (error) {
        onError?.(error, 'save')
      }
    },
    remove: async (id) => {
      try {
        if (existsSync(fileFor(id))) unlinkSync(fileFor(id))
      } catch (error) {
        onError?.(error, 'remove')
      }
    },
  }
}

export interface ConversationRecord {
  data: PersistedConversation
  chatSession: ChatSessionRuntime
}

function sortByRecency(records: Iterable<ConversationRecord>): ConversationRecord[] {
  return [...records].sort((a, b) => b.data.updatedAt - a.data.updatedAt || (b.data.createdAt - a.data.createdAt))
}

export function titleFromPrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, ' ')
  if (!normalized) return DEFAULT_CONVERSATION_TITLE
  return normalized.slice(0, MAX_TITLE_CHARS)
}

export class ConversationRegistry {
  private readonly records = new Map<string, ConversationRecord>()
  private activeId: string
  /** Monotonic clock: keeps recency order deterministic within one millisecond. */
  private lastTick = 0

  private constructor(private readonly store: ConversationStorePort, activeId: string) {
    this.activeId = activeId
  }

  private stamp(): number {
    this.lastTick = Math.max(Date.now(), this.lastTick + 1)
    return this.lastTick
  }

  static async load(store: ConversationStorePort, preferredId?: string): Promise<ConversationRegistry> {
    const persisted = await store.list()
    const registry = new ConversationRegistry(store, '')
    for (const conversation of persisted) {
      registry.records.set(conversation.id, { data: conversation, chatSession: new ChatSessionRuntime() })
      registry.lastTick = Math.max(registry.lastTick, conversation.updatedAt, conversation.createdAt)
    }
    if (preferredId && registry.records.has(preferredId)) {
      registry.activeId = preferredId
    } else if (preferredId) {
      registry.activeId = registry.createRecord({ id: preferredId, title: DEFAULT_CONVERSATION_TITLE })
      await registry.persist(registry.activeId)
    } else if (registry.records.size === 0) {
      registry.activeId = registry.createRecord({ title: DEFAULT_CONVERSATION_TITLE })
      await registry.persist(registry.activeId)
    } else {
      registry.activeId = sortByRecency(registry.records.values())[0].data.id
    }
    return registry
  }

  private createRecord(init: { id?: string; title?: string }): string {
    const now = this.stamp()
    const id = init.id ?? randomUUID()
    this.records.set(id, {
      data: {
        id,
        title: init.title ?? DEFAULT_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
        messages: [],
        toolTraces: [],
      },
      chatSession: new ChatSessionRuntime(),
    })
    return id
  }

  async persist(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    record.data.updatedAt = this.stamp()
    await this.store.save(record.data)
  }

  getActive(): ConversationRecord {
    const record = this.records.get(this.activeId)
    if (!record) throw new Error('No active conversation')
    return record
  }

  getActiveId(): string {
    return this.activeId
  }

  list(): ConversationSummary[] {
    return sortByRecency(this.records.values()).map((record) => ({
      id: record.data.id,
      title: record.data.title,
      updatedAt: record.data.updatedAt,
      turnCount: record.data.messages.filter((message) => message.role === 'user').length,
      active: record.data.id === this.activeId,
    }))
  }

  /**
   * Matches exact id, then 1-based position in recency order for all-digit
   * refs (list numbers are the primary affordance), then unique id prefix.
   * Full ids always exact-match, so digit-leading ids stay addressable.
   */
  resolveRef(ref: string): string | null {
    const trimmed = ref.trim()
    if (!trimmed) return null
    if (this.records.has(trimmed)) return trimmed
    if (/^\d+$/.test(trimmed)) {
      const index = Number(trimmed)
      if (Number.isInteger(index) && index >= 1) {
        return this.list()[index - 1]?.id ?? null
      }
      return null
    }
    const prefix = [...this.records.keys()].filter((id) => id.startsWith(trimmed))
    return prefix.length === 1 ? prefix[0] : null
  }

  async create(title?: string): Promise<string> {
    const normalized = title?.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_CHARS)
    this.activeId = this.createRecord({ title: normalized || DEFAULT_CONVERSATION_TITLE })
    await this.persist(this.activeId)
    return this.activeId
  }

  async switch(ref: string): Promise<ConversationSummary | null> {
    const id = this.resolveRef(ref)
    if (!id) return null
    this.activeId = id
    const record = this.records.get(id)
    if (!record) return null
    return {
      id: record.data.id,
      title: record.data.title,
      updatedAt: record.data.updatedAt,
      turnCount: record.data.messages.filter((message) => message.role === 'user').length,
      active: true,
    }
  }

  async rename(ref: string, title: string): Promise<ConversationSummary | null> {
    const normalized = title.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_CHARS)
    if (!normalized) return null
    const id = this.resolveRef(ref)
    const record = id ? this.records.get(id) : undefined
    if (!record) return null
    record.data.title = normalized
    await this.persist(id as string)
    return {
      id: record.data.id,
      title: record.data.title,
      updatedAt: record.data.updatedAt,
      turnCount: record.data.messages.filter((message) => message.role === 'user').length,
      active: record.data.id === this.activeId,
    }
  }

  /** Deletes one conversation; never leaves the registry empty. Returns the new active id. */
  async delete(ref: string): Promise<string | null> {
    const id = this.resolveRef(ref)
    if (!id) return null
    this.records.delete(id)
    await this.store.remove(id)
    if (this.records.size === 0) {
      this.activeId = this.createRecord({ title: DEFAULT_CONVERSATION_TITLE })
      await this.persist(this.activeId)
    } else if (this.activeId === id) {
      this.activeId = sortByRecency(this.records.values())[0].data.id
    }
    return this.activeId
  }

  /** Clears the active conversation history and its loaded-file evidence. */
  async resetActive(): Promise<void> {
    const record = this.getActive()
    record.data.messages = []
    record.data.toolTraces = []
    record.chatSession = new ChatSessionRuntime()
    await this.persist(record.data.id)
  }

  /**
   * Fresh start: opens a new empty conversation and drops every previous
   * one (memory + store files), so each TUI launch begins with a clean
   * slate instead of resuming the last conversation.
   */
  async freshStart(): Promise<string> {
    const freshId = this.createRecord({ title: DEFAULT_CONVERSATION_TITLE })
    for (const id of [...this.records.keys()]) {
      if (id === freshId) continue
      this.records.delete(id)
      await this.store.remove(id)
    }
    this.activeId = freshId
    await this.persist(freshId)
    return freshId
  }
}
