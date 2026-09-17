import { countSearchHits, searchWorkspace } from './workspace-search'
import { readdir, readFile, stat } from 'fs/promises'
import { spawn } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { dirname, join, resolve } from 'path'
import { resolveWorkspaceTarget } from '../path-guard'
import { evaluateWorkspaceReadPolicy, isSensitivePath, redactHighConfidenceSecrets } from '../policy-gate'
import type { RegisteredTool, ToolRegistry } from '../registry'
import { isTextBuffer, janusWorkspaceFs, MAX_PAGE_BYTES, MAX_PAGE_LINES } from '../../environment/janus-workspace-fs'
import { MAX_OUTPUT_TOKEN_BUDGET, estimateOutputTokens, fitItemsToBudget, parseOutputTokenBudget } from './output-budget'
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

const DEFAULT_DEPTH = 2
const MAX_DEPTH = 4
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_OVERVIEW_MAX_ENTRIES = 300
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
// Note: adaptive pages, token budgets, and search-carried hashes cut diagnostic round trips — see .agents/notes/implemented/bug-fix/2026-09-16-read-paging-token-amplification.md
export const workspaceReadTool: RegisteredTool = {
  name: 'workspace.read',
  description: 'Read one UTF-8 text file as line pages (files ≤100KB return whole from offset, larger files default 800 lines or 48KB, whichever first). Use offset/limit for large files and continue with offset=nextOffset while truncated is true. Returns the full-file SHA-256 for edits; withLineAnchors:true also returns a LINE#HASH anchor per line for hash-anchored lineEdits in workspace.edit. maxTokens optionally tightens the page further.',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The exact workspaceId from the attached workspace list.' },
      path: { type: 'string', description: 'Workspace-relative file path, e.g. src/notes/test.md.' },
      offset: { type: 'number', description: '1-indexed line number to start from (default 1).' },
      limit: { type: 'number', description: 'Max lines to return (default 800, max 2000; omitted with maxBytes on files ≤100KB returns whole).' },
      maxBytes: { type: 'number', description: 'Max bytes of page content (default 49152, max 1048576). The byte cap wins over limit.' },
      maxTokens: { type: 'number', description: `Optional output budget in tokens (1-${MAX_OUTPUT_TOKEN_BUDGET}); tighter than the page caps when given.` },
      withLineAnchors: { type: 'boolean', description: 'Also return a LINE#HASH anchor array for this page (for workspace.edit lineEdits).' },
    },
    required: ['workspaceId', 'path'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path
    const offset = input.offset ?? 1
    // Omitted caps resolve adaptively inside readWorkspaceTextPage (≤100KB
    // returns whole); explicit values are validated there.
    const limit = input.limit
    const maxBytes = input.maxBytes
    const maxTokens = parseOutputTokenBudget(input.maxTokens, 'workspace.read')
    const withLineAnchors = input.withLineAnchors ?? false
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.read workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.read path must be a string')
    if (typeof withLineAnchors !== 'boolean') throw new Error('workspace.read withLineAnchors must be a boolean')
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
      throw new Error('workspace.read offset must be a non-negative integer line number (1-indexed, 0 is accepted as line 1)')
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_LINES)) {
      throw new Error(`workspace.read limit must be an integer between 1 and ${MAX_PAGE_LINES}`)
    }
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > MAX_PAGE_BYTES)) {
      throw new Error(`workspace.read maxBytes must be an integer between 1 and ${MAX_PAGE_BYTES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    const read = await janusWorkspaceFs.readWorkspaceTextPage(
      context.workspaceRoot,
      requestedPath,
      Number(offset),
      limit === undefined ? undefined : Number(limit),
      maxBytes === undefined ? undefined : Number(maxBytes),
      evaluateWorkspaceReadPolicy,
    )
    if (!read.ok) throw read.error
    const page = read.value
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    // sha256 is always computed from disk content: edits to unmasked regions
    // still match, and only the masked credential itself becomes uneditable.
    // The token budget applies before masking (masking can join lines), and
    // anchors hash the same unmasked lines the model sees positions for.
    const pageText = page.content.toString('utf-8')
    let takenText = pageText
    let budgetTruncated = false
    let totalTokens: number | undefined
    if (maxTokens !== undefined) {
      totalTokens = estimateOutputTokens(pageText)
      if (totalTokens > maxTokens) {
        const fitted = fitItemsToBudget(pageText.split('\n'), (line) => line, maxTokens)
        takenText = fitted.items.join('\n')
        budgetTruncated = fitted.truncated || estimateOutputTokens(takenText) > maxTokens
      }
    }
    const { text: content, redacted } = redactHighConfidenceSecrets(takenText)
    const truncated = page.truncated || budgetTruncated
    const lineEnd = page.lineStart + takenText.split('\n').length - 1
    const guidance = truncated
      ? page.truncated
        ? `Showing lines ${page.lineStart}-${lineEnd} of ${page.totalLines}. Use workspace_read with offset=${lineEnd + 1} to continue.`
        : `Showing ${takenText.split('\n').length} of ${page.lineEnd - page.lineStart + 1} page lines within maxTokens=${maxTokens} (${totalTokens} tokens total). Re-read with a larger maxTokens or a narrower offset/limit.`
      : undefined
    // Anchors cover the lines actually returned (after the byte cap may have
    // cut the page short) and hash the on-disk line, so redacted regions keep
    // a stable anchor even though their content cannot be edited.
    const lineAnchors = withLineAnchors
      ? buildLineAnchors(takenText, page.lineStart, takenText.split('\n').length)
      : undefined
    const estimatedTokens = estimateOutputTokens(content)
    return {
      workspaceId,
      path: requestedPath,
      encoding: 'utf-8',
      size: page.size,
      offset: page.lineStart,
      lineStart: page.lineStart,
      lineEnd,
      totalLines: page.totalLines,
      bytes: Buffer.byteLength(takenText, 'utf-8'),
      truncated,
      ...(truncated ? { nextOffset: lineEnd + 1 } : {}),
      ...(guidance === undefined ? {} : { guidance }),
      ...(lineAnchors === undefined ? {} : { lineAnchors }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      estimatedTokens,
      content,
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
  description: 'Apply bounded exact replacements, one unified diff, or hash-anchored lineEdits to an existing workspace file after approval. expectedHash accepts the SHA-256 from workspace.read or from a workspace.search content match when the file is unchanged, so a located fix needs no second read. lineEdits need the LINE#HASH anchors from workspace.read withLineAnchors:true and apply bottom-up; any anchor mismatch aborts the whole batch and returns fresh anchors.',
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

export interface WorkspaceTreeEntry {
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
  /** File bytes (directories report 0); lets the model skip oversized files before reading. */
  size: number
  /** Modification time in whole seconds; ordering signal, ties break alphabetically. */
  mtime: number
}

/**
 * Bounded tree walk shared by workspace.list and workspace.overview.
 * Directories sort before files (navigation stays a tree); within each group
 * recently modified entries sort first so active work surfaces without
 * globals or extra calls. Symlinks never resolve: they are skipped before
 * stat, so a raced path can at most leak a stale size, never content.
 */
async function walkWorkspaceTree(options: {
  rootPath: string
  baseRelative: string
  depth: number
  maxEntries: number
  signal: AbortSignal
  cancelMessage: string
}): Promise<{ entries: WorkspaceTreeEntry[]; truncated: boolean }> {
  const { rootPath, baseRelative, depth, maxEntries, signal, cancelMessage } = options
  const entries: WorkspaceTreeEntry[] = []
  let truncated = false

  const walk = async (directoryPath: string, relativeDirectory: string, currentDepth: number): Promise<void> => {
    if (currentDepth > depth || truncated) return
    if (signal.aborted) throw new Error(cancelMessage)
    const children = await readdir(directoryPath, { withFileTypes: true })
    const visible: Array<{ name: string; childPath: string; isDirectory: boolean; size: number; mtimeMs: number }> = []
    await Promise.all(children.map(async (child) => {
      if (signal.aborted) throw new Error(cancelMessage)
      if (child.isSymbolicLink()) return
      if (!child.isDirectory() && !child.isFile()) return
      const childPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
      if (isSensitivePath(childPath)) return
      try {
        const info = await stat(join(directoryPath, child.name))
        visible.push({
          name: child.name,
          childPath,
          isDirectory: child.isDirectory(),
          size: child.isDirectory() ? 0 : info.size,
          mtimeMs: info.mtimeMs,
        })
      } catch {
        return
      }
    }))
    visible.sort((left, right) => {
      const leftDirectory = left.isDirectory ? 0 : 1
      const rightDirectory = right.isDirectory ? 0 : 1
      return leftDirectory - rightDirectory
        || right.mtimeMs - left.mtimeMs
        || left.name.localeCompare(right.name)
    })
    for (const child of visible) {
      if (signal.aborted) throw new Error(cancelMessage)
      entries.push({
        path: child.childPath,
        name: child.name,
        type: child.isDirectory ? 'directory' : 'file',
        depth: currentDepth,
        size: child.size,
        mtime: Math.floor(child.mtimeMs / 1000),
      })
      if (entries.length > maxEntries) {
        truncated = true
        entries.pop()
        return
      }
      if (child.isDirectory && currentDepth < depth) {
        await walk(join(directoryPath, child.name), child.childPath, currentDepth + 1)
        if (truncated) return
      }
    }
  }

  await walk(rootPath, baseRelative, 1)
  return { entries, truncated }
}

/** Best-effort git summary for workspace.overview; undefined outside a repo or on timeout. */
async function readGitSummary(workspaceRoot: string): Promise<{
  branch: string
  head: string
  staged: number
  unstaged: number
  untracked: number
} | undefined> {
  const runGit = (args: string[]): Promise<string | undefined> => new Promise((resolveGit) => {
    let output = ''
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolveGit(value)
    }
    let child
    try {
      child = spawn('git', args, { cwd: workspaceRoot, windowsHide: true })
    } catch {
      finish(undefined)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0 ? output : undefined)
    })
  })
  const [branch, head, porcelain] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(['rev-parse', 'HEAD']),
    runGit(['status', '--porcelain=v1', '--no-renames', '--untracked-files=normal', '-z']),
  ])
  if (porcelain === undefined) return undefined
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const record of porcelain.split('\0').filter(Boolean)) {
    const indexState = record[0]
    const worktreeState = record[1]
    if (indexState === '?' && worktreeState === '?') untracked += 1
    else {
      if (indexState !== undefined && indexState !== ' ' && indexState !== '?') staged += 1
      if (worktreeState !== undefined && worktreeState !== ' ' && worktreeState !== '?') unstaged += 1
    }
  }
  return {
    branch: branch?.trim() || 'unknown',
    head: head?.trim() || 'unknown',
    staged,
    unstaged,
    untracked,
  }
}

function fitEntriesToBudget<T extends { path: string }>(
  entries: T[],
  maxTokens: number | undefined,
): { entries: T[]; budgetTruncated: boolean; totalTokens?: number; totalEntries?: number } {
  if (maxTokens === undefined) return { entries, budgetTruncated: false }
  const totalTokens = estimateOutputTokens(JSON.stringify(entries))
  if (totalTokens <= maxTokens) return { entries, budgetTruncated: false }
  const fitted = fitItemsToBudget(entries, (entry) => JSON.stringify(entry), maxTokens)
  return {
    entries: fitted.items,
    budgetTruncated: fitted.truncated || estimateOutputTokens(JSON.stringify(fitted.items)) > maxTokens,
    totalTokens,
    totalEntries: entries.length,
  }
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
  description: 'List a bounded, non-sensitive file tree inside an explicitly selected workspace. Entries carry sizes and modification times with recently modified paths first; prefer workspace.overview when the shape of the checkout is unknown.',
  actionRisk: 'list',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'number' },
      maxEntries: { type: 'number' },
      maxTokens: { type: 'number', description: `Optional output budget in tokens (1-${MAX_OUTPUT_TOKEN_BUDGET}).` },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path ?? ''
    const depth = input.depth ?? DEFAULT_DEPTH
    const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
    const maxTokens = parseOutputTokenBudget(input.maxTokens, 'workspace.list')
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
    const { entries, truncated: walkTruncated } = await walkWorkspaceTree({
      rootPath,
      baseRelative: target.relativePath,
      depth,
      maxEntries,
      signal: context.signal,
      cancelMessage: 'workspace.list cancelled',
    })
    const fitted = fitEntriesToBudget(entries, maxTokens)
    const truncated = walkTruncated || fitted.budgetTruncated
    return {
      workspaceId,
      path: target.relativePath,
      depth,
      entries: fitted.entries,
      truncated,
      ...(truncated && !walkTruncated
        ? {
          totalEntries: fitted.totalEntries,
          totalTokens: fitted.totalTokens,
          guidance: `Entries exceed maxTokens=${maxTokens} (${fitted.totalTokens} tokens over ${fitted.totalEntries} entries). Re-list with a larger maxTokens, a deeper path, or a smaller maxEntries.`,
        }
        : {}),
      estimatedTokens: estimateOutputTokens(JSON.stringify(fitted.entries)),
    }
  },
}

export const workspaceOverviewTool: RegisteredTool = {
  name: 'workspace.overview',
  description: 'Read a shallow bounded tree of an explicitly selected workspace with file sizes, modification times, and a git working-tree summary. Start here when the checkout shape is unknown instead of looping workspace.list.',
  actionRisk: 'list',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'number' },
      maxEntries: { type: 'number' },
      maxTokens: { type: 'number', description: `Optional output budget in tokens (1-${MAX_OUTPUT_TOKEN_BUDGET}).` },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path ?? ''
    const depth = input.depth ?? DEFAULT_DEPTH
    const maxEntries = input.maxEntries ?? DEFAULT_OVERVIEW_MAX_ENTRIES
    const maxTokens = parseOutputTokenBudget(input.maxTokens, 'workspace.overview')
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.overview workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.overview path must be a string')
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
      throw new Error(`workspace.overview depth must be an integer between 0 and ${MAX_DEPTH}`)
    }
    if (typeof maxEntries !== 'number' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MAX_ENTRIES) {
      throw new Error(`workspace.overview maxEntries must be an integer between 1 and ${MAX_MAX_ENTRIES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.overview cancelled')

    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (target.kind !== 'directory') throw new Error('workspace.overview path must be a directory')
    const rootPath = resolve(context.workspaceRoot, target.relativePath || '.')
    const [{ entries, truncated: walkTruncated }, git] = await Promise.all([
      walkWorkspaceTree({
        rootPath,
        baseRelative: target.relativePath,
        depth,
        maxEntries,
        signal: context.signal,
        cancelMessage: 'workspace.overview cancelled',
      }),
      readGitSummary(context.workspaceRoot),
    ])
    const fitted = fitEntriesToBudget(entries, maxTokens)
    const truncated = walkTruncated || fitted.budgetTruncated
    return {
      workspaceId,
      path: target.relativePath,
      depth,
      entries: fitted.entries,
      truncated,
      ...(git === undefined ? {} : { git }),
      ...(truncated && !walkTruncated
        ? {
          totalEntries: fitted.totalEntries,
          totalTokens: fitted.totalTokens,
          guidance: `Entries exceed maxTokens=${maxTokens} (${fitted.totalTokens} tokens over ${fitted.totalEntries} entries). Re-run with a larger maxTokens, a deeper path, or a smaller maxEntries.`,
        }
        : {}),
      estimatedTokens: estimateOutputTokens(JSON.stringify(fitted.entries)),
    }
  },
}

export const workspaceSearchTool: RegisteredTool = {
  name: 'workspace.search',
  description: 'Find code with bounded ignore-aware search. Returns flat {path, line, text} hits by default (cheap first probe). mode=files searches file paths with recently modified files first; pass withContext:true for one hunk group per file (clustered hits share context, distant hunks carry a skipped-lines gap count) with the file SHA-256 (usable as workspace.edit expectedHash while unchanged). Filter with path/glob; regex enables multi-symbol patterns. Literal case-insensitive matching is the default.',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' }, query: { type: 'string' }, path: { type: 'string' },
      glob: { type: 'string' }, mode: { type: 'string', enum: ['content', 'files'] },
      regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, maxResults: { type: 'number' },
      withContext: { type: 'boolean' },
      maxTokens: { type: 'number', description: `Optional output budget in tokens (1-${MAX_OUTPUT_TOKEN_BUDGET}).` },
    },
    required: ['workspaceId'], additionalProperties: false,
  },
  execute: async (input, context) => {
    const { workspaceId } = input
    const query = input.query ?? ''
    const requestedPath = input.path ?? ''
    const mode = input.mode ?? 'content'
    const maxResults = input.maxResults ?? 30
    const maxTokens = parseOutputTokenBudget(input.maxTokens, 'workspace.search')
    if (workspaceId !== context.workspaceId) throw new Error('workspace.search workspaceId must match the active workspace resource')
    if (mode !== 'content' && mode !== 'files') throw new Error('workspace.search mode must be content or files')
    if (typeof query !== 'string' || query.length > 256 || (mode === 'content' && !query.trim())) throw new Error('workspace.search query must be 1-256 characters for content search')
    if (typeof requestedPath !== 'string') throw new Error('workspace.search path must be a string')
    if (input.glob !== undefined && (typeof input.glob !== 'string' || input.glob.length > 256)) throw new Error('workspace.search glob must be at most 256 characters')
    for (const key of ['regex', 'caseSensitive', 'withContext']) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`workspace.search ${key} must be a boolean`)
    }
    if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new Error('workspace.search maxResults must be an integer between 1 and 100')
    if (context.signal.aborted) throw new Error('workspace.search cancelled')
    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (isSensitivePath(target.relativePath)) throw new Error('Workspace search denied: sensitive path')
    const scopedFile = target.kind === 'file' ? target.relativePath : undefined
    const parent = scopedFile ? dirname(scopedFile).replaceAll('\\', '/') : target.relativePath
    const path = parent === '.' ? '' : parent
    const result = await searchWorkspace({
      root: context.workspaceRoot, path, scopedFile, query, mode, maxResults,
      glob: input.glob as string | undefined, regex: input.regex === true,
      caseSensitive: input.caseSensitive === true, withContext: input.withContext === true, signal: context.signal,
    })
    const totalTokens = estimateOutputTokens(JSON.stringify(result.matches))
    let matches = result.matches
    let budgetTruncated = false
    let totalResults: number | undefined
    if (maxTokens !== undefined && totalTokens > maxTokens) {
      const fitted = fitItemsToBudget(matches, (match) => JSON.stringify(match), maxTokens)
      matches = fitted.items
      budgetTruncated = fitted.truncated || estimateOutputTokens(JSON.stringify(fitted.items)) > maxTokens
      totalResults = countSearchHits(result.matches)
    }
    const truncated = result.truncated || budgetTruncated
    return {
      workspaceId, query, path, ...result,
      matches,
      truncated,
      ...(truncated && !result.truncated
        ? {
          totalResults,
          totalTokens,
          guidance: `Matches exceed maxTokens=${maxTokens} (${totalTokens} tokens over ${totalResults} matches). Re-search with a larger maxTokens or a narrower path/glob/query.`,
        }
        : {}),
      estimatedTokens: estimateOutputTokens(JSON.stringify(matches)),
      ...(scopedFile ? { scopedFile, note: `path pointed to a file; the search was scoped to ${scopedFile}. ${result.note ?? ''}`.trim() } : {}),
    }
  },
}

export function registerWorkspaceTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(workspaceReadTool)
  registry.register(workspaceListTool)
  registry.register(workspaceOverviewTool)
  registry.register(workspaceEditTool)
  registry.register(workspaceCreateTool)
  registry.register(workspaceDeleteTool)
  registry.register(workspaceSearchTool)
  registeredRegistries.add(registry)
}
