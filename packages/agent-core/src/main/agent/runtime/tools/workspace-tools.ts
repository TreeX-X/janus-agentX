import { readdir, readFile, stat } from 'fs/promises'
import { isUtf8 } from 'node:buffer'
import { dirname, join, resolve } from 'path'
import { resolveWorkspaceTarget } from '../path-guard'
import { evaluateWorkspaceReadPolicy, isSensitivePath, redactHighConfidenceSecrets } from '../policy-gate'
import type { RegisteredTool, ToolRegistry } from '../registry'
import { isTextBuffer, janusWorkspaceFs, DEFAULT_PAGE_BYTES, DEFAULT_PAGE_LINES, MAX_PAGE_LINES } from '../../environment/janus-workspace-fs'
import { checkpointManager } from '../../checkpoint/checkpoint-manager'
import {
  atomicReplaceWorkspaceFile,
  buildLineAnchors,
  commitWorkspaceDelete,
  createWorkspaceFile,
  freshAnchorsAround,
  prepareWorkspaceDelete,
  prepareWorkspaceEdit,
  prepareWorkspaceLineEdit,
  prepareWorkspaceUnifiedDiffEdit,
  MAX_WORKSPACE_EDIT_BYTES,
  type WorkspaceExactReplacement,
  type WorkspaceLineEdit,
} from '../file-transaction'

const MAX_MAX_BYTES = 1024 * 1024
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 4
const DEFAULT_MAX_ENTRIES = 200
const MAX_MAX_ENTRIES = 1000
const registeredRegistries = new WeakSet<ToolRegistry>()

// Note: per-call verified diffs feed the change cards — see .agents/notes/implemented/feature/2026-09-13-checkpoint-diff-cards.md
/** Source side over this size skips the preview; the card falls back to summary. */
const MAX_DIFF_PREVIEW_SOURCE_BYTES = 256 * 1024
/** Bounded unified preview carried on the tool output for display only. */
const MAX_DIFF_PREVIEW_CHARS = 4_000

export interface CallDiffPreview {
  diffPreview: string
  diffTruncated: boolean
}

function boundPreview(raw: string): CallDiffPreview {
  return raw.length > MAX_DIFF_PREVIEW_CHARS
    ? { diffPreview: raw.slice(0, MAX_DIFF_PREVIEW_CHARS), diffTruncated: true }
    : { diffPreview: raw, diffTruncated: false }
}

function prefixLines(content: string, prefix: '+' | '-'): string {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => `${prefix}${line}`).join('\n')
}

/** Exact byte blocks this call applies, rendered as one hunk per replacement. */
function replacementsDiffPreview(path: string, value: unknown): CallDiffPreview | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const hunks: string[] = []
  for (const [index, item] of value.entries()) {
    const replacement = item && typeof item === 'object'
      ? item as { oldText?: unknown; newText?: unknown }
      : {}
    if (typeof replacement.oldText !== 'string' || typeof replacement.newText !== 'string') return undefined
    if (Buffer.byteLength(replacement.oldText, 'utf-8') + Buffer.byteLength(replacement.newText, 'utf-8') > MAX_DIFF_PREVIEW_SOURCE_BYTES) return undefined
    hunks.push([
      `@@ replacement ${index + 1}/${value.length} @@`,
      prefixLines(replacement.oldText, '-'),
      prefixLines(replacement.newText, '+'),
    ].join('\n'))
  }
  return boundPreview([`--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n'))
}

function unifiedInputDiffPreview(value: unknown): CallDiffPreview | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (Buffer.byteLength(value, 'utf-8') > MAX_DIFF_PREVIEW_SOURCE_BYTES) return undefined
  return boundPreview(value)
}

function createDiffPreview(path: string, content: string): CallDiffPreview | undefined {
  if (Buffer.byteLength(content, 'utf-8') > MAX_DIFF_PREVIEW_SOURCE_BYTES) return undefined
  return boundPreview([`--- /dev/null`, `+++ b/${path}`, `@@`, prefixLines(content, '+')].join('\n'))
}

function deleteDiffPreview(path: string, content: Buffer): CallDiffPreview | undefined {
  if (content.byteLength > MAX_DIFF_PREVIEW_SOURCE_BYTES || !isUtf8(content)) return undefined
  return boundPreview([`--- a/${path}`, `+++ /dev/null`, `@@`, prefixLines(content.toString('utf-8'), '-')].join('\n'))
}

/** Line-level `LINE#HASH` anchors for one replacement, for change cards. */
function lineEditsDiffPreview(path: string, value: unknown): CallDiffPreview | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const hunks: string[] = []
  for (const [index, item] of value.entries()) {
    const edit = item && typeof item === 'object'
      ? item as { line?: unknown; anchor?: unknown; newText?: unknown }
      : {}
    if (typeof edit.line !== 'number' || typeof edit.newText !== 'string') return undefined
    hunks.push([
      `@@ line ${edit.line}${typeof edit.anchor === 'string' ? ` anchor=${edit.anchor}` : ''} (${index + 1}/${value.length}) @@`,
      prefixLines(edit.newText, '+'),
    ].join('\n'))
  }
  return boundPreview([`--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n'))
}

// Note: line-paged reads keep large-file evidence reachable without re-reading the head — see .agents/notes/implemented/feature/2026-09-15-workspace-read-line-pages.md
export const workspaceReadTool: RegisteredTool = {
  name: 'workspace.read',
  description: 'Read one UTF-8 text file as line pages (default 200 lines or 50KB, whichever first). Use offset/limit for large files and continue with offset=nextOffset while truncated is true. Returns the full-file SHA-256 for edits; withLineAnchors:true also returns a LINE#HASH anchor per line for hash-anchored lineEdits in workspace.edit.',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The exact workspaceId from the attached workspace list.' },
      path: { type: 'string', description: 'Workspace-relative file path, e.g. src/notes/test.md.' },
      offset: { type: 'number', description: '1-indexed line number to start from (default 1).' },
      limit: { type: 'number', description: 'Max lines to return (default 200, max 2000).' },
      maxBytes: { type: 'number', description: 'Max bytes of page content (default 51200, max 1048576). The byte cap wins over limit.' },
      withLineAnchors: { type: 'boolean', description: 'Also return a LINE#HASH anchor array for this page (for workspace.edit lineEdits).' },
    },
    required: ['workspaceId', 'path'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path
    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_PAGE_LINES
    const maxBytes = input.maxBytes ?? DEFAULT_PAGE_BYTES
    const withLineAnchors = input.withLineAnchors ?? false
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.read workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.read path must be a string')
    if (typeof withLineAnchors !== 'boolean') throw new Error('workspace.read withLineAnchors must be a boolean')
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
      throw new Error('workspace.read offset must be a non-negative integer line number (1-indexed, 0 is accepted as line 1)')
    }
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_LINES) {
      throw new Error(`workspace.read limit must be an integer between 1 and ${MAX_PAGE_LINES}`)
    }
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > MAX_MAX_BYTES) {
      throw new Error(`workspace.read maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    const read = await janusWorkspaceFs.readWorkspaceTextPage(
      context.workspaceRoot,
      requestedPath,
      Number(offset),
      Number(limit),
      Number(maxBytes),
      evaluateWorkspaceReadPolicy,
    )
    if (!read.ok) throw read.error
    const page = read.value
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    // sha256 is always computed from disk content: edits to unmasked regions
    // still match, and only the masked credential itself becomes uneditable.
    const { text, redacted } = redactHighConfidenceSecrets(page.content.toString('utf-8'))
    const guidance = page.truncated
      ? `Showing lines ${page.lineStart}-${page.lineEnd} of ${page.totalLines}. Use workspace_read with offset=${page.nextOffset} to continue.`
      : undefined
    // Anchors cover the lines actually returned (after the byte cap may have
    // cut the page short) and hash the on-disk line, so redacted regions keep
    // a stable anchor even though their content cannot be edited.
    const lineAnchors = withLineAnchors
      ? buildLineAnchors(page.content.toString('utf-8'), page.lineStart, page.lineEnd - page.lineStart + 1)
      : undefined
    return {
      workspaceId,
      path: requestedPath,
      encoding: 'utf-8',
      size: page.size,
      offset: page.lineStart,
      lineStart: page.lineStart,
      lineEnd: page.lineEnd,
      totalLines: page.totalLines,
      bytes: page.bytes,
      truncated: page.truncated,
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      ...(guidance === undefined ? {} : { guidance }),
      ...(lineAnchors === undefined ? {} : { lineAnchors }),
      content: text,
      sha256: page.sha256,
      contentRedacted: redacted,
      ...(redacted ? {
        redactionNotice: 'High-confidence credential material was masked as [REDACTED]. The sha256 covers the original file; masked regions cannot be used as oldText in workspace.edit.',
      } : {}),
    }
  },
}

export const workspaceEditTool: RegisteredTool = {
  name: 'workspace.edit',
  description: 'Apply bounded exact replacements, one unified diff, or hash-anchored lineEdits to an existing workspace file after approval. lineEdits need the LINE#HASH anchors from workspace.read withLineAnchors:true and apply bottom-up; any anchor mismatch aborts the whole batch and returns fresh anchors.',
  actionRisk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      expectedHash: { type: 'string' },
      replacements: { type: 'array' },
      unifiedDiff: { type: 'string' },
      lineEdits: { type: 'array' },
    },
    required: ['workspaceId', 'path', 'expectedHash'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('workspace.edit workspaceId must match the active workspace resource')
    }
    if (typeof input.path !== 'string' || typeof input.expectedHash !== 'string') {
      throw new Error('workspace.edit input is invalid')
    }
    const hasReplacements = input.replacements !== undefined
    const hasUnifiedDiff = input.unifiedDiff !== undefined
    const hasLineEdits = input.lineEdits !== undefined
    if (Number(hasReplacements) + Number(hasUnifiedDiff) + Number(hasLineEdits) !== 1) {
      throw new Error('workspace.edit requires exactly one of replacements, unifiedDiff, or lineEdits')
    }
    if (hasReplacements && !Array.isArray(input.replacements)) throw new Error('workspace.edit replacements must be an array')
    if (hasUnifiedDiff && typeof input.unifiedDiff !== 'string') throw new Error('workspace.edit unifiedDiff must be a string')
    if (hasLineEdits && !Array.isArray(input.lineEdits)) throw new Error('workspace.edit lineEdits must be an array')
    if (context.signal.aborted) throw new Error('workspace.edit cancelled')
    const prepare = () => hasUnifiedDiff
      ? prepareWorkspaceUnifiedDiffEdit(context.workspaceRoot, input.path as string, input.expectedHash as string, input.unifiedDiff as string)
      : hasLineEdits
        ? prepareWorkspaceLineEdit(context.workspaceRoot, input.path as string, input.expectedHash as string, input.lineEdits as WorkspaceLineEdit[])
        : prepareWorkspaceEdit(context.workspaceRoot, input.path as string, input.expectedHash as string, input.replacements as WorkspaceExactReplacement[])
    let prepared = await prepare()
    await checkpointManager.initialize(context.workspaceRoot)
    const checkpoint = await checkpointManager.createCheckpoint({
      terminalId: `workspace-chat:${context.workspaceId}`,
      engine: 'manual',
      prompt: `workspace.edit ${prepared.path}`,
      cwd: context.workspaceRoot,
    })
    if (context.signal.aborted) throw new Error('workspace.edit cancelled')
    prepared = await prepare()
    await atomicReplaceWorkspaceFile(context.workspaceRoot, prepared)
    const callDiff = hasUnifiedDiff
      ? unifiedInputDiffPreview(input.unifiedDiff)
      : hasLineEdits
        ? lineEditsDiffPreview(prepared.path, input.lineEdits)
        : replacementsDiffPreview(prepared.path, input.replacements)
    return {
      workspaceId: context.workspaceId,
      path: prepared.path,
      changedPaths: [prepared.path],
      previousHash: prepared.previousHash,
      sha256: prepared.nextHash,
      editMode: prepared.editMode,
      replacements: prepared.replacements,
      bytes: Buffer.byteLength(prepared.nextContent),
      checkpointId: checkpoint.id,
      ...(callDiff ?? {}),
    }
  },
}

export const workspaceCreateTool: RegisteredTool = {
  name: 'workspace.create',
  description: 'Create a new UTF-8 text file inside the current workspace after approval. Fails when the target exists; use workspace.edit to overwrite it',
  actionRisk: 'create',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['workspaceId', 'path', 'content'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('workspace.create workspaceId must match the active workspace resource')
    }
    if (typeof input.path !== 'string' || typeof input.content !== 'string') {
      throw new Error('workspace.create input is invalid')
    }
    if (Buffer.byteLength(input.content, 'utf-8') > MAX_WORKSPACE_EDIT_BYTES) {
      throw new Error(`workspace.create content exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
    }
    if (context.signal.aborted) throw new Error('workspace.create cancelled')
    await checkpointManager.initialize(context.workspaceRoot)
    const checkpoint = await checkpointManager.createCheckpoint({
      terminalId: `workspace-chat:${context.workspaceId}`,
      engine: 'manual',
      prompt: `workspace.create ${input.path}`,
      cwd: context.workspaceRoot,
    })
    if (context.signal.aborted) throw new Error('workspace.create cancelled')
    const created = await createWorkspaceFile(context.workspaceRoot, input.path, input.content)
    return {
      workspaceId: context.workspaceId,
      path: created.path,
      changedPaths: [created.path],
      sha256: created.sha256,
      bytes: created.bytes,
      checkpointId: checkpoint.id,
      ...(createDiffPreview(created.path, input.content) ?? {}),
    }
  },
}

type WorkspaceListEntry = {
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
}

export const workspaceDeleteTool: RegisteredTool = {
  name: 'workspace.delete',
  description: 'Delete one workspace file, symlink, or directory after approval. Directories with entries require recursive:true. The workspace root, .janusX audit state, and sensitive paths are refused. Prefer this over shell rm: deletions are previewed, audited, and checkpointed for restore.',
  actionRisk: 'delete',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      recursive: { type: 'boolean' },
    },
    required: ['workspaceId', 'path'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('workspace.delete workspaceId must match the active workspace resource')
    }
    if (typeof input.path !== 'string') {
      throw new Error('workspace.delete path must be a string')
    }
    const recursive = input.recursive ?? false
    if (typeof recursive !== 'boolean') {
      throw new Error('workspace.delete recursive must be a boolean')
    }
    if (context.signal.aborted) throw new Error('workspace.delete cancelled')
    // Same prepare → checkpoint → re-prepare → commit-verify shape as
    // workspace.edit: the approver saw the first census, the commit verifies it.
    let prepared = await prepareWorkspaceDelete(context.workspaceRoot, input.path, recursive)
    await checkpointManager.initialize(context.workspaceRoot)
    const checkpoint = await checkpointManager.createCheckpoint({
      terminalId: `workspace-chat:${context.workspaceId}`,
      engine: 'manual',
      prompt: `workspace.delete ${prepared.path}`,
      cwd: context.workspaceRoot,
    })
    if (context.signal.aborted) throw new Error('workspace.delete cancelled')
    prepared = await prepareWorkspaceDelete(context.workspaceRoot, input.path, recursive)
    // Capture file bytes before the commit so the card shows this call's own
    // deletion diff; anything unreadable falls back to the kind/size summary.
    let deletedContent: Buffer | undefined
    if (prepared.kind === 'file' && prepared.sha256 !== undefined && prepared.bytes <= MAX_DIFF_PREVIEW_SOURCE_BYTES) {
      try {
        deletedContent = await readFile(prepared.targetPath)
      } catch {
        deletedContent = undefined
      }
    }
    const committed = await commitWorkspaceDelete(context.workspaceRoot, prepared)
    return {
      workspaceId: context.workspaceId,
      path: committed.path,
      kind: committed.kind,
      bytes: committed.bytes,
      entryCount: committed.entryCount,
      ...(prepared.sha256 ? { sha256: prepared.sha256 } : {}),
      changedPaths: [committed.path],
      checkpointId: checkpoint.id,
      ...(deletedContent ? (deleteDiffPreview(committed.path, deletedContent) ?? {}) : {}),
    }
  },
}

export const workspaceListTool: RegisteredTool = {
  name: 'workspace.list',
  description: 'List a bounded, non-sensitive file tree inside an explicitly selected workspace',
  actionRisk: 'list',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'number' },
      maxEntries: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path ?? ''
    const depth = input.depth ?? DEFAULT_DEPTH
    const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.list workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.list path must be a string')
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
      throw new Error(`workspace.list depth must be an integer between 0 and ${MAX_DEPTH}`)
    }
    if (typeof maxEntries !== 'number' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MAX_ENTRIES) {
      throw new Error(`workspace.list maxEntries must be an integer between 1 and ${MAX_MAX_ENTRIES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.list cancelled')

    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (target.kind !== 'directory') throw new Error('workspace.list path must be a directory')
    const rootPath = resolve(context.workspaceRoot, target.relativePath || '.')
    const entries: WorkspaceListEntry[] = []
    let truncated = false

    const walk = async (directoryPath: string, relativeDirectory: string, currentDepth: number): Promise<void> => {
      if (currentDepth > depth || truncated) return
      if (context.signal.aborted) throw new Error('workspace.list cancelled')
      const children = await readdir(directoryPath, { withFileTypes: true })
      children.sort((left, right) => {
        const leftDirectory = left.isDirectory() ? 0 : 1
        const rightDirectory = right.isDirectory() ? 0 : 1
        return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
      })
      for (const child of children) {
        if (context.signal.aborted) throw new Error('workspace.list cancelled')
        if (child.isSymbolicLink()) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const childPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
        if (isSensitivePath(childPath)) continue
        entries.push({
          path: childPath,
          name: child.name,
          type: child.isDirectory() ? 'directory' : 'file',
          depth: currentDepth,
        })
        if (entries.length > maxEntries) {
          truncated = true
          entries.pop()
          return
        }
        if (child.isDirectory() && currentDepth < depth) {
          await walk(join(directoryPath, child.name), childPath, currentDepth + 1)
          if (truncated) return
        }
      }
    }

    await walk(rootPath, target.relativePath, 1)
    return {
      workspaceId,
      path: target.relativePath,
      depth,
      entries,
      truncated,
    }
  },
}

const SEARCH_MAX_QUERY_CHARS = 256
const SEARCH_MAX_RESULTS = 50
const SEARCH_MAX_FILES = 2_000
const SEARCH_MAX_FILE_BYTES = 512 * 1024
const SEARCH_MAX_LINE_CHARS = 300
const SEARCH_MAX_DEPTH = 8
const SEARCH_SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv',
  // P4: command.run logs live under .janusX/logs (read them via the logPath
  // from the tool result, not via search) — keep build output out of code search.
  '.janusX',
])

type WorkspaceSearchMatch = {
  path: string
  line: number
  text: string
}

export const workspaceSearchTool: RegisteredTool = {
  name: 'workspace.search',
  description: 'Search UTF-8 text files in the workspace for a literal substring and return matching lines. The path must be a directory; a file path scopes the search to that file and the result carries a note',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      query: { type: 'string' },
      path: { type: 'string' },
      maxResults: { type: 'number' },
    },
    required: ['workspaceId', 'query'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const query = input.query
    const requestedPath = input.path ?? ''
    const maxResults = input.maxResults ?? SEARCH_MAX_RESULTS
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.search workspaceId must match the active workspace resource')
    }
    if (typeof query !== 'string' || !query.trim() || query.length > SEARCH_MAX_QUERY_CHARS) {
      throw new Error(`workspace.search query must be 1-${SEARCH_MAX_QUERY_CHARS} characters`)
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.search path must be a string')
    if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > SEARCH_MAX_RESULTS) {
      throw new Error(`workspace.search maxResults must be an integer between 1 and ${SEARCH_MAX_RESULTS}`)
    }
    if (context.signal.aborted) throw new Error('workspace.search cancelled')

    // Note: a file path scopes the search to that file instead of failing — see .agents/notes/implemented/feature/2026-09-13-tool-failure-recovery.md
    let target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    let scopedFile: string | undefined
    if (target.kind === 'file') {
      scopedFile = target.relativePath
      const parent = dirname(scopedFile)
      target = await resolveWorkspaceTarget(context.workspaceRoot, parent === '.' ? '' : parent)
    }
    const rootPath = resolve(context.workspaceRoot, target.relativePath || '.')
    const needle = query.toLowerCase()
    const matches: WorkspaceSearchMatch[] = []
    let scannedFiles = 0
    let truncated = false

    const walk = async (directoryPath: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (truncated || depth > SEARCH_MAX_DEPTH) return
      if (context.signal.aborted) throw new Error('workspace.search cancelled')
      const children = await readdir(directoryPath, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name))
      for (const child of children) {
        if (truncated) return
        if (context.signal.aborted) throw new Error('workspace.search cancelled')
        if (child.isSymbolicLink()) continue
        const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
        if (isSensitivePath(childRelative)) continue
        if (scopedFile !== undefined && childRelative !== scopedFile && !scopedFile.startsWith(`${childRelative}/`)) continue
        if (child.isDirectory()) {
          if (SEARCH_SKIPPED_DIRECTORIES.has(child.name)) continue
          await walk(join(directoryPath, child.name), childRelative, depth + 1)
          continue
        }
        if (!child.isFile()) continue
        if (scannedFiles >= SEARCH_MAX_FILES) { truncated = true; return }
        scannedFiles++
        const filePath = join(directoryPath, child.name)
        try {
          if ((await stat(filePath)).size > SEARCH_MAX_FILE_BYTES) continue
          const content = await readFile(filePath)
          if (!isTextBuffer(content)) continue
          const lines = content.toString('utf-8').split('\n')
          for (const [index, line] of lines.entries()) {
            if (!line.toLowerCase().includes(needle)) continue
            matches.push({
              path: childRelative,
              line: index + 1,
              text: line.length > SEARCH_MAX_LINE_CHARS ? `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…` : line,
            })
            if (matches.length >= maxResults) { truncated = true; break }
          }
        } catch {
          // Unreadable files are skipped, not fatal to the search.
        }
      }
    }

    await walk(rootPath, target.relativePath, 1)
    return {
      workspaceId,
      query,
      path: target.relativePath,
      matches,
      scannedFiles,
      truncated,
      ...(scopedFile === undefined ? {} : {
        scopedFile,
        note: `path pointed to a file; the search was scoped to ${scopedFile}`,
      }),
    }
  },
}

export function registerWorkspaceTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(workspaceReadTool)
  registry.register(workspaceListTool)
  registry.register(workspaceEditTool)
  registry.register(workspaceCreateTool)
  registry.register(workspaceDeleteTool)
  registry.register(workspaceSearchTool)
  registeredRegistries.add(registry)
}
