import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, readlink, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { evaluateWorkspaceReadPolicy, isSensitivePath } from './policy-gate'
import {
  readWorkspaceFile,
  resolveWorkspaceCreationTarget,
  resolveWorkspaceTarget,
  sameWorkspaceFileIdentity,
  WorkspacePathGuardError,
} from './path-guard'

export const MAX_WORKSPACE_EDIT_BYTES = 1024 * 1024
export const MAX_WORKSPACE_REPLACEMENTS = 40

export interface WorkspaceExactReplacement {
  oldText: string
  newText: string
}

export interface PreparedWorkspaceEdit {
  path: string
  previousHash: string
  nextHash: string
  previousContent: string
  nextContent: string
  replacements: number
  editMode: 'replace_blocks' | 'unified_diff'
}

export class WorkspaceEditConflictError extends Error {
  readonly code = 'TARGET_CHANGED'
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEditConflictError'
  }
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertText(content: Buffer): string {
  if (!isUtf8(content) || content.some((byte) =>
    byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d),
  )) {
    throw new Error('workspace.edit only supports UTF-8 text files')
  }
  return content.toString('utf-8')
}

function applyExactReplacements(content: string, replacements: WorkspaceExactReplacement[]): string {
  if (replacements.length < 1 || replacements.length > MAX_WORKSPACE_REPLACEMENTS) {
    throw new Error(`workspace.edit requires between 1 and ${MAX_WORKSPACE_REPLACEMENTS} replacements`)
  }
  let next = content
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement || typeof replacement.oldText !== 'string' || typeof replacement.newText !== 'string') {
      throw new Error(`workspace.edit replacement ${index + 1} is invalid`)
    }
    if (!replacement.oldText) throw new Error(`workspace.edit replacement ${index + 1} oldText must not be empty`)
    const first = next.indexOf(replacement.oldText)
    if (first < 0) throw new WorkspaceEditConflictError(`workspace.edit replacement ${index + 1} no longer matches the file`)
    if (next.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new WorkspaceEditConflictError(`workspace.edit replacement ${index + 1} is ambiguous`)
    }
    next = `${next.slice(0, first)}${replacement.newText}${next.slice(first + replacement.oldText.length)}`
    if (Buffer.byteLength(next) > MAX_WORKSPACE_EDIT_BYTES) {
      throw new Error(`workspace.edit output exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
    }
  }
  return next
}

interface UnifiedDiffLine {
  kind: ' ' | '+' | '-'
  content: string
}

interface UnifiedDiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: UnifiedDiffLine[]
  newNoFinalNewline: boolean
}

interface ParsedUnifiedDiff {
  oldPath: string
  newPath: string
  metadataPaths: string[]
  hunks: UnifiedDiffHunk[]
}

function normalizeUnifiedDiffPath(value: string): string {
  const path = value.split('\t', 1)[0]?.trim()
  if (!path || path === '/dev/null') throw new Error('workspace.edit unifiedDiff must target an existing file')
  return path.replace(/^[ab]\//, '')
}

function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (typeof diff !== 'string' || diff.length === 0) throw new Error('workspace.edit unifiedDiff must not be empty')
  const lines = diff.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  let cursor = 0
  const metadataPaths: string[] = []
  if (lines[cursor]?.startsWith('diff --git ')) {
    const match = /^diff --git (.+) (.+)$/.exec(lines[cursor] ?? '')
    if (!match) throw new Error('workspace.edit unifiedDiff contains an invalid diff header')
    metadataPaths.push(normalizeUnifiedDiffPath(match[1]), normalizeUnifiedDiffPath(match[2]))
    cursor += 1
  }
  while (lines[cursor]?.startsWith('index ')) cursor += 1
  const oldHeader = lines[cursor]
  const newHeader = lines[cursor + 1]
  if (!oldHeader?.startsWith('--- ') || !newHeader?.startsWith('+++ ')) {
    throw new Error('workspace.edit unifiedDiff must begin with --- and +++ file headers')
  }
  const parsed: ParsedUnifiedDiff = {
    oldPath: normalizeUnifiedDiffPath(oldHeader.slice(4)),
    newPath: normalizeUnifiedDiffPath(newHeader.slice(4)),
    metadataPaths,
    hunks: [],
  }
  cursor += 2

  while (cursor < lines.length) {
    const header = lines[cursor]
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header ?? '')
    if (!match) throw new Error('workspace.edit unifiedDiff contains an invalid hunk header')
    const hunk: UnifiedDiffHunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
      lines: [],
      newNoFinalNewline: false,
    }
    cursor += 1
    while (cursor < lines.length && !lines[cursor]?.startsWith('@@ ')) {
      const line = lines[cursor] ?? ''
      if (line === '\\ No newline at end of file') {
        const previous = hunk.lines.at(-1)
        if (!previous) throw new Error('workspace.edit unifiedDiff has an invalid no-newline marker')
        if (previous.kind !== '-') hunk.newNoFinalNewline = true
        cursor += 1
        continue
      }
      const kind = line[0] as UnifiedDiffLine['kind']
      if (kind !== ' ' && kind !== '+' && kind !== '-') {
        throw new Error('workspace.edit unifiedDiff contains an invalid hunk line')
      }
      hunk.lines.push({ kind, content: line.slice(1) })
      cursor += 1
    }
    const oldLines = hunk.lines.filter((line) => line.kind !== '+').length
    const newLines = hunk.lines.filter((line) => line.kind !== '-').length
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
      throw new Error('workspace.edit unifiedDiff hunk line counts do not match its header')
    }
    parsed.hunks.push(hunk)
  }
  if (parsed.hunks.length === 0) throw new Error('workspace.edit unifiedDiff must contain at least one hunk')
  return parsed
}

function splitTextLines(content: string): { lines: string[]; eol: string; hasFinalNewline: boolean } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(content)
  const lines = content === '' ? [] : content.split(/\r\n|\n|\r/)
  if (hasFinalNewline) lines.pop()
  return { lines, eol, hasFinalNewline }
}

function applyUnifiedDiff(content: string, requestedPath: string, diff: string): { content: string; hunks: number } {
  const parsed = parseUnifiedDiff(diff)
  if ([parsed.oldPath, parsed.newPath, ...parsed.metadataPaths].some((path) => path !== requestedPath)) {
    throw new Error('workspace.edit unifiedDiff paths must match the requested path')
  }
  const source = splitTextLines(content)
  const nextLines: string[] = []
  let sourceIndex = 0
  let hasFinalNewline = source.hasFinalNewline

  for (const hunk of parsed.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    if (hunkStart < sourceIndex || hunkStart > source.lines.length) {
      throw new WorkspaceEditConflictError('workspace.edit unifiedDiff hunks overlap or do not match the file')
    }
    nextLines.push(...source.lines.slice(sourceIndex, hunkStart))
    sourceIndex = hunkStart
    let insertedLines = 0
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        nextLines.push(line.content)
        insertedLines += 1
        continue
      }
      if (source.lines[sourceIndex] !== line.content) {
        throw new WorkspaceEditConflictError('workspace.edit unifiedDiff context no longer matches the file')
      }
      if (line.kind === ' ') {
        nextLines.push(source.lines[sourceIndex])
        insertedLines += 1
      }
      sourceIndex += 1
    }
    if (insertedLines !== hunk.newCount) throw new Error('workspace.edit unifiedDiff output count is invalid')
    const hunkTouchesSourceEnd = hunk.oldCount === 0
      ? hunk.oldStart === source.lines.length
      : hunk.oldStart + hunk.oldCount - 1 === source.lines.length
    if (hunkTouchesSourceEnd) {
      hasFinalNewline = hunk.newCount > 0 && !hunk.newNoFinalNewline
    }
  }
  nextLines.push(...source.lines.slice(sourceIndex))
  const next = nextLines.join(source.eol) + (nextLines.length > 0 && hasFinalNewline ? source.eol : '')
  if (next === content) throw new Error('workspace.edit does not change the file')
  if (Buffer.byteLength(next) > MAX_WORKSPACE_EDIT_BYTES) {
    throw new Error(`workspace.edit output exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
  }
  return { content: next, hunks: parsed.hunks.length }
}

async function prepareWorkspaceEditWithTransform(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  editMode: PreparedWorkspaceEdit['editMode'],
  transform: (content: string, path: string) => { content: string; operations: number },
): Promise<PreparedWorkspaceEdit> {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('workspace.edit expectedHash must be a SHA-256 hash')
  const target = await resolveWorkspaceTarget(workspaceRoot, requestedPath)
  if (target.kind !== 'file') throw new Error('workspace.edit path must be a regular file')
  const content = await readWorkspaceFile(
    workspaceRoot,
    requestedPath,
    MAX_WORKSPACE_EDIT_BYTES,
    evaluateWorkspaceReadPolicy,
  )
  const previousHash = sha256(content)
  if (previousHash !== expectedHash.toLowerCase()) {
    throw new WorkspaceEditConflictError('workspace.edit expectedHash does not match the current file')
  }
  const previousContent = assertText(content)
  const result = transform(previousContent, target.relativePath)
  return {
    path: target.relativePath,
    previousHash,
    nextHash: sha256(result.content),
    previousContent,
    nextContent: result.content,
    replacements: result.operations,
    editMode,
  }
}

export async function prepareWorkspaceEdit(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  replacements: WorkspaceExactReplacement[],
): Promise<PreparedWorkspaceEdit> {
  return prepareWorkspaceEditWithTransform(
    workspaceRoot,
    requestedPath,
    expectedHash,
    'replace_blocks',
    (content) => ({ content: applyExactReplacements(content, replacements), operations: replacements.length }),
  )
}

export async function prepareWorkspaceUnifiedDiffEdit(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  unifiedDiff: string,
): Promise<PreparedWorkspaceEdit> {
  return prepareWorkspaceEditWithTransform(
    workspaceRoot,
    requestedPath,
    expectedHash,
    'unified_diff',
    (content, path) => {
      const result = applyUnifiedDiff(content, path, unifiedDiff)
      return { content: result.content, operations: result.hunks }
    },
  )
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}

export interface CreatedWorkspaceFile {
  path: string
  sha256: string
  bytes: number
}

export async function createWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
): Promise<CreatedWorkspaceFile> {
  if (typeof content !== 'string') throw new Error('workspace.create content must be a string')
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_WORKSPACE_EDIT_BYTES) {
    throw new Error(`workspace.create content exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
  }
  const target = await resolveWorkspaceCreationTarget(workspaceRoot, requestedPath)
  if (isSensitivePath(target.relativePath)) {
    const error = new Error('Workspace target is a sensitive path')
    throw Object.assign(error, { code: 'SENSITIVE_PATH' })
  }
  // 'wx' fails if the target appeared between resolution and write (no overwrite path).
  const handle = await open(target.targetPath, 'wx', 0o644)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { path: target.relativePath, sha256: sha256(content), bytes }
}

export const MAX_DELETE_WALK_ENTRIES = 1000
export const MAX_DELETE_PREVIEW_ENTRIES = 20

export type WorkspaceDeleteKind = 'file' | 'directory' | 'symlink'

export interface PreparedWorkspaceDelete {
  /** Workspace-relative path with `/` separators (canonical parent + requested leaf). */
  path: string
  /** Absolute leaf path (parent realpathed, leaf appended — the leaf itself is never followed). */
  targetPath: string
  kind: WorkspaceDeleteKind
  /** File size in bytes; 0 for directories and symlinks. */
  bytes: number
  /** SHA-256 for files within the edit size cap (conflict check); undefined for large files. */
  sha256?: string
  /** Size + mtime fallback conflict signal for files too large to hash. */
  mtimeMs?: number
  /** readlink target for symlinks (conflict check: the link must not have been swapped). */
  linkTarget?: string
  identity: { dev: bigint; ino: bigint }
  /** Recursive entry count for directories (files + dirs + links); 0 otherwise. */
  entryCount: number
  /** True when the walk stopped at MAX_DELETE_WALK_ENTRIES (count is a lower bound). */
  entriesTruncated: boolean
  /** First relative entries (sorted, bounded) for the approval preview. */
  entries: string[]
  recursive: boolean
}

function deleteDenied(code: 'SENSITIVE_PATH' | 'PROTECTED_PATH' | 'DIRECTORY_NOT_EMPTY', message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Resolve a path for deletion. Unlike `resolveWorkspaceTarget` (which
 * realpaths the whole target, i.e. FOLLOWS a final-component symlink),
 * the leaf is inspected with `lstat` and never followed: deleting a symlink
 * unlinks the link object inside the workspace, never its target. The parent
 * chain is still canonicalized, so a symlinked parent cannot escape the root.
 */
export async function prepareWorkspaceDelete(
  workspaceRoot: string,
  requestedPath: string,
  recursive: boolean,
): Promise<PreparedWorkspaceDelete> {
  if (!workspaceRoot) {
    throw new WorkspacePathGuardError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable')
  }
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
  if (isAbsoluteOnAnyPlatformLocal(requestedPath)) {
    throw new WorkspacePathGuardError('ABSOLUTE_PATH', 'Absolute paths are not allowed')
  }
  const segments = requestedPath.split(/[\\/]+/).filter(Boolean)
  if (segments.includes('..')) {
    throw new WorkspacePathGuardError('PATH_TRAVERSAL', 'Parent path traversal is not allowed')
  }
  if (segments.length === 0) {
    throw deleteDenied('PROTECTED_PATH', 'workspace.delete refuses the workspace root itself')
  }
  // Self-protection (pi-tools parity): the agent must not eat its own audit
  // trail, checkpoints, or command logs. The shell owns the same layout.
  if (segments[0].toLowerCase() === '.janusx') {
    throw deleteDenied('PROTECTED_PATH', 'workspace.delete refuses .janusX audit and checkpoint state')
  }

  const rootPath = await canonicalPathLocal(workspaceRoot)
  const leaf = segments.at(-1) as string
  const parentRel = segments.slice(0, -1).join('/')
  const parentTarget = await resolveWorkspaceTarget(workspaceRoot, parentRel)
  if (parentTarget.kind !== 'directory') {
    throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace parent is not a directory')
  }
  const parentAbs = resolve(rootPath, parentTarget.relativePath.split('/').join(sep))
  const targetPath = resolve(parentAbs, leaf)
  const relativePath = parentTarget.relativePath ? `${parentTarget.relativePath}/${leaf}` : leaf
  if (isSensitivePath(relativePath)) {
    throw deleteDenied('SENSITIVE_PATH', 'Workspace target is a sensitive path')
  }

  let leafStat
  try {
    leafStat = await lstat(targetPath, { bigint: true })
  } catch {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
  const identity = { dev: leafStat.dev, ino: leafStat.ino }

  if (leafStat.isSymbolicLink()) {
    return {
      path: relativePath,
      targetPath,
      kind: 'symlink',
      bytes: 0,
      linkTarget: await readlinkLocal(targetPath),
      identity,
      entryCount: 0,
      entriesTruncated: false,
      entries: [],
      recursive,
    }
  }
  if (leafStat.isFile()) {
    const bytes = Number(leafStat.size)
    const prepared: PreparedWorkspaceDelete = {
      path: relativePath,
      targetPath,
      kind: 'file',
      bytes,
      identity,
      entryCount: 0,
      entriesTruncated: false,
      entries: [],
      recursive,
    }
    if (bytes <= MAX_WORKSPACE_EDIT_BYTES) {
      prepared.sha256 = sha256(await readLeafFile(targetPath, bytes))
    } else {
      prepared.mtimeMs = Number(leafStat.mtimeMs)
    }
    return prepared
  }
  if (leafStat.isDirectory()) {
    const { entryCount, entriesTruncated, entries } = await walkDeleteEntries(targetPath, relativePath)
    if (entryCount > 0 && !recursive) {
      throw deleteDenied(
        'DIRECTORY_NOT_EMPTY',
        `workspace.delete refuses a non-empty directory without recursive:true (${entryCount}${entriesTruncated ? '+' : ''} entries)`,
      )
    }
    return {
      path: relativePath,
      targetPath,
      kind: 'directory',
      bytes: 0,
      identity,
      entryCount,
      entriesTruncated,
      entries,
      recursive,
    }
  }
  throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace target is not a regular file or directory')
}

async function walkDeleteEntries(targetPath: string, relativePath: string): Promise<Pick<PreparedWorkspaceDelete, 'entryCount' | 'entriesTruncated' | 'entries'>> {
  const entries: string[] = []
  let entryCount = 0
  let entriesTruncated = false
  // Iterative stack walk, never following symlinks (Dirent.lstat semantics:
  // a symlink is counted as one entry and never descended into).
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: targetPath, relative: relativePath }]
  while (stack.length > 0) {
    const current = stack.pop() as { absolute: string; relative: string }
    let children
    try {
      children = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
    }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (!child.isDirectory() && !child.isFile() && !child.isSymbolicLink()) continue
      entryCount += 1
      const childRelative = `${current.relative}/${child.name}`
      if (entries.length < MAX_DELETE_PREVIEW_ENTRIES) entries.push(childRelative)
      if (entryCount > MAX_DELETE_WALK_ENTRIES) {
        entriesTruncated = true
        return { entryCount, entriesTruncated, entries }
      }
      if (child.isDirectory()) {
        stack.push({ absolute: resolve(current.absolute, child.name), relative: childRelative })
      }
    }
  }
  return { entryCount, entriesTruncated, entries }
}

export interface CommittedWorkspaceDelete {
  path: string
  kind: WorkspaceDeleteKind
  bytes: number
  entryCount: number
}

/**
 * Re-validate a prepared delete against live filesystem state, then commit.
 * Mirrors the edit flow (prepare → checkpoint → re-prepare → commit-verify):
 * identity/hash/mtime/link-target/census mismatches fail closed with
 * TARGET_CHANGED instead of deleting something the approver never saw.
 */
export async function commitWorkspaceDelete(
  workspaceRoot: string,
  prepared: PreparedWorkspaceDelete,
): Promise<CommittedWorkspaceDelete> {
  const rootPath = await canonicalPathLocal(workspaceRoot)
  const parentRel = prepared.path.split('/').slice(0, -1).join('/')
  const parentReal = await realpathLocal(resolve(rootPath, parentRel.split('/').filter(Boolean).join(sep) || '.'))
  if (isOutsideRootLocal(relative(rootPath, parentReal))) {
    throw new WorkspacePathGuardError('OUTSIDE_WORKSPACE', 'Workspace target is outside the workspace')
  }
  const leafAbs = resolve(parentReal, basename(prepared.path))
  // The parent chain must resolve byte-identically to prepare time: any
  // difference means a parent component was swapped (e.g. symlink swap) and
  // the leaf would no longer be the object the approver saw.
  if (leafAbs !== prepared.targetPath) {
    throw new WorkspaceEditConflictError('workspace.delete parent directory changed before delete')
  }
  let leafStat
  try {
    leafStat = await lstat(leafAbs, { bigint: true })
  } catch {
    throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
  }
  if (prepared.kind === 'symlink') {
    if (!leafStat.isSymbolicLink() || await readlinkLocal(leafAbs) !== prepared.linkTarget) {
      throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
    }
    await unlink(leafAbs)
    return { path: prepared.path, kind: prepared.kind, bytes: 0, entryCount: 0 }
  }
  if (prepared.kind === 'file') {
    if (!leafStat.isFile()) throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
    if (prepared.sha256 !== undefined) {
      const bytes = Number(leafStat.size)
      if (bytes > MAX_WORKSPACE_EDIT_BYTES
        || sha256(await readLeafFile(leafAbs, bytes)) !== prepared.sha256) {
        throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
      }
    } else if (Number(leafStat.size) !== prepared.bytes || Number(leafStat.mtimeMs) !== prepared.mtimeMs) {
      throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
    }
    await unlink(leafAbs)
    return { path: prepared.path, kind: prepared.kind, bytes: prepared.bytes, entryCount: 0 }
  }
  if (!leafStat.isDirectory()) throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
  if (sameWorkspaceFileIdentity(
    { dev: leafStat.dev, ino: leafStat.ino },
    prepared.identity,
  )) {
    // Identity stable: same object the approver saw.
  } else if (!prepared.entriesTruncated) {
    const census = await walkDeleteEntries(leafAbs, prepared.path)
    if (census.entryCount !== prepared.entryCount) {
      throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
    }
  }
  // entriesTruncated + unstable identity: membership cannot be re-verified
  // (re-walking a 1000+ entry tree is unbounded work). The kind + parent
  // containment above still hold; the residual TOCTOU is documented and matches
  // the approval the user already gave for this exact path.
  try {
    await rm(leafAbs, { recursive: true, force: false })
  } catch {
    throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
  }
  return { path: prepared.path, kind: prepared.kind, bytes: 0, entryCount: prepared.entryCount }
}

// Local aliases: path-guard internals (isOutsideRoot/canonicalPath) are not
// exported, and the delete resolver intentionally differs (no leaf realpath),
// so the three helpers below mirror the guard's semantics for this module.
function isAbsoluteOnAnyPlatformLocal(value: string): boolean {
  return isAbsolute(value) || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)
}

function isOutsideRootLocal(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}

async function canonicalPathLocal(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    throw new WorkspacePathGuardError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable')
  }
}

async function realpathLocal(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
}

async function readlinkLocal(targetPath: string): Promise<string> {
  try {
    return await readlink(targetPath)
  } catch {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
}

async function readLeafFile(targetPath: string, bytes: number): Promise<Buffer> {
  try {
    const content = await readFile(targetPath)
    if (content.byteLength !== bytes) {
      throw new WorkspaceEditConflictError('workspace.delete target changed before delete')
    }
    return content
  } catch (error) {
    if (error instanceof WorkspaceEditConflictError) throw error
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
}

export async function atomicReplaceWorkspaceFile(
  workspaceRoot: string,
  prepared: PreparedWorkspaceEdit,
): Promise<void> {
  const rootPath = await realpath(workspaceRoot)
  const targetPath = await realpath(resolve(rootPath, prepared.path.split('/').join(sep)))
  if (isOutsideRoot(relative(rootPath, targetPath))) {
    throw new WorkspacePathGuardError('OUTSIDE_WORKSPACE', 'Workspace target is outside the workspace')
  }
  const targetHandle = await open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let targetHandleClosed = false
  let temporaryPath = ''
  try {
    const openedStat = await targetHandle.stat({ bigint: true })
    if (!openedStat.isFile()) throw new WorkspaceEditConflictError('workspace.edit target is no longer a regular file')
    if (openedStat.size > BigInt(MAX_WORKSPACE_EDIT_BYTES)) {
      throw new WorkspaceEditConflictError('workspace.edit target changed beyond the edit size limit')
    }
    const currentContent = await targetHandle.readFile()
    if (sha256(currentContent) !== prepared.previousHash) {
      throw new WorkspaceEditConflictError('workspace.edit target changed before write')
    }

    const parentPath = dirname(targetPath)
    if (await realpath(parentPath) !== parentPath) {
      throw new WorkspaceEditConflictError('workspace.edit parent directory changed before write')
    }
    temporaryPath = resolve(parentPath, `.janusx-edit-${randomUUID()}.tmp`)
    const temporaryHandle = await open(temporaryPath, 'wx', Number(openedStat.mode & 0o777n))
    try {
      await temporaryHandle.writeFile(prepared.nextContent, 'utf-8')
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }

    const freshStat = await stat(targetPath, { bigint: true })
    if (!sameWorkspaceFileIdentity(openedStat, freshStat)) {
      throw new WorkspaceEditConflictError('workspace.edit target changed before replacement')
    }
    // Windows does not allow replacing a file while this process still holds it open.
    await targetHandle.close()
    targetHandleClosed = true
    await rename(temporaryPath, targetPath)
    temporaryPath = ''
  } finally {
    if (!targetHandleClosed) await targetHandle.close().catch(() => undefined)
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
  }
}
