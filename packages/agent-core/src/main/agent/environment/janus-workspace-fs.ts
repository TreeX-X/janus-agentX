import { isUtf8 } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '../../lib/atomic-file'
import { readWorkspaceFile, readWorkspaceFileRange, WorkspacePathGuardError, type WorkspaceFileRange, type WorkspaceReadAuthorizer } from '../runtime/path-guard'
import { isSensitivePath } from '../runtime/policy-gate'
import type { BlueprintEvidenceManifest } from '../../../shared/janus/maintenance-types'

export type JanusResult<T> = { ok: true; value: T } | { ok: false; error: Error }

export interface WorkspaceEvidenceContext {
  context: string
  manifest: BlueprintEvidenceManifest
}

export interface WorkspaceContextOptions {
  maxFiles?: number
  maxFileBytes?: number
  maxContextBytes?: number
  extensions?: ReadonlySet<string>
  excludedDirectories?: ReadonlySet<string>
}

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.css', '.html', '.xml'])
const DEFAULT_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'release', 'coverage', '.cache'])

// Note: adaptive page caps keep small-file evidence in one round trip — see .agents/notes/implemented/bug-fix/2026-09-16-read-paging-token-amplification.md
// Note: smaller locate-first defaults (opencode cost parity) — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
// Large-file default pages are locate-first (300 lines/20KB): enough to land
// on the right region, cheap to replay every turn. Continuation via
// offset=nextOffset stays one cheap round trip, so narrower defaults trade a
// rare extra turn for a ~60% smaller blob on every turn.
/** Full-file ceiling for a paged read; the whole file is hashed for edit safety. */
export const MAX_PAGED_READ_BYTES = 16 * 1024 * 1024
/**
 * Default page when the caller passes no caps. Files at or below
 * ADAPTIVE_FULL_FILE_BYTES return whole (bounded by the maxima instead), so
 * a single default read covers an ordinary source file end to end.
 */
export const DEFAULT_PAGE_LINES = 300
export const MAX_PAGE_LINES = 2000
export const DEFAULT_PAGE_BYTES = 20 * 1024
export const MAX_PAGE_BYTES = 1024 * 1024
export const ADAPTIVE_FULL_FILE_BYTES = 40 * 1024

export interface WorkspaceTextPage {
  content: Buffer
  lineStart: number
  lineEnd: number
  totalLines: number
  size: number
  sha256: string
  truncated: boolean
  nextOffset?: number
  bytes: number
}

function failure(error: unknown): { ok: false; error: Error } {
  return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
}

export function isTextBuffer(content: Buffer): boolean {
  return isUtf8(content) && !content.some((byte) =>
    byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d),
  )
}

/** Count LF bytes; safe on UTF-8 because 0x0A never appears inside a multibyte sequence. */
function countNewlines(content: Buffer): number {
  let count = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) count += 1
  }
  return count
}

/**
 * Byte range of 1-indexed lines [lineStart, lineEnd] without decoding the
 * file. The walk stops at the first newline past the window (early stop);
 * totalLines is counted separately by a cheap byte scan. An empty trailing
 * segment after a final newline counts as a line, matching split('\n'), so
 * slicing to EOF covers it.
 */
function sliceLineRange(content: Buffer, lineStart: number, lineEnd: number): Buffer {
  let start = 0
  let end = content.length
  let line = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue
    if (line === lineEnd) {
      end = index
      break
    }
    line += 1
    if (line === lineStart) start = index + 1
  }
  return content.subarray(start, end)
}

async function gitIgnoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set()
  return new Promise((resolveIgnored) => {
    let output = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolveIgnored(new Set(output.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'))))
    }
    let command
    try { command = spawn('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: root, windowsHide: true }) }
    catch { finish(); return }
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    command.on('error', finish)
    command.on('close', finish)
    command.stdin.end(`${paths.join('\0')}\0`)
  })
}

async function gitEvidence(root: string, paths: string[]): Promise<{ gitHead?: string; states: Map<string, BlueprintEvidenceManifest['files'][number]['sourceState']> }> {
  const states = new Map<string, BlueprintEvidenceManifest['files'][number]['sourceState']>()
  const gitHead = await new Promise<string | undefined>((resolveHead) => {
    let output = ''
    const command = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    command.on('error', () => resolveHead(undefined))
    command.on('close', (code) => resolveHead(code === 0 ? output.trim() || undefined : undefined))
  })
  if (!paths.length) return { gitHead, states }
  await new Promise<void>((resolveStates) => {
    let output = ''
    const command = spawn('git', ['status', '--porcelain=v1', '--no-renames', '-z', '--', ...paths], { cwd: root, windowsHide: true })
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    const finish = () => {
      for (const record of output.split('\0').filter(Boolean)) {
        const path = record.slice(3).replaceAll('\\', '/')
        const indexState = record[0]
        const worktreeState = record[1]
        states.set(path, indexState === '?' ? 'untracked' : indexState !== ' ' ? 'staged' : worktreeState !== ' ' ? 'unstaged' : 'committed')
      }
      resolveStates()
    }
    command.on('error', finish)
    command.on('close', finish)
    command.stdin.end()
  })
  return { gitHead, states }
}

export class JanusWorkspaceFs {
  async readText(path: string, maxBytes = 1024 * 1024): Promise<JanusResult<{ content: string; size: number; mtime: number }>> {
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
      const buffer = await fs.readFile(path)
      if (!isTextBuffer(buffer)) throw new Error('File is not UTF-8 text')
      return { ok: true, value: { content: buffer.toString('utf8'), size: info.size, mtime: info.mtimeMs } }
    } catch (error) { return failure(error) }
  }

  async readBinary(path: string, maxBytes = 16 * 1024 * 1024): Promise<JanusResult<{ buffer: Buffer; size: number; mtime: number }>> {
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
      return { ok: true, value: { buffer: await fs.readFile(path), size: info.size, mtime: info.mtimeMs } }
    } catch (error) { return failure(error) }
  }

  async stat(path: string): Promise<JanusResult<{ size: number; mtime: number; isFile: boolean }>> {
    try {
      const info = await fs.stat(path)
      return { ok: true, value: { size: info.size, mtime: info.mtimeMs, isFile: info.isFile() } }
    } catch (error) { return failure(error) }
  }

  async writeText(path: string, content: string): Promise<JanusResult<void>> {
    try {
      await writeFileAtomic(path, content)
      return { ok: true, value: undefined }
    } catch (error) { return failure(error) }
  }

  async readWorkspaceText(
    workspaceRoot: string,
    requestedPath: string,
    maxBytes: number,
    authorize: WorkspaceReadAuthorizer,
  ): Promise<JanusResult<Buffer>> {
    try {
      const content = await readWorkspaceFile(workspaceRoot, requestedPath, maxBytes, authorize)
      if (!isTextBuffer(content)) throw new Error('Workspace file is not UTF-8 text')
      return { ok: true, value: content }
    } catch (error) { return failure(error) }
  }

  async readWorkspaceTextRange(
    workspaceRoot: string,
    requestedPath: string,
    offset: number,
    maxBytes: number,
    authorize: WorkspaceReadAuthorizer,
  ): Promise<JanusResult<WorkspaceFileRange>> {
    try {
      const read = await readWorkspaceFileRange(workspaceRoot, requestedPath, offset, maxBytes, authorize)
      let start = 0
      while (start < read.content.length && (read.content[start] & 0xc0) === 0x80) start += 1
      let end = read.content.length
      while (end > start && !isTextBuffer(read.content.subarray(start, end))) end -= 1
      if (end < read.content.length - 3 || (end === start && read.content.length > 0)) {
        throw new Error('Workspace file is not UTF-8 text')
      }
      const content = read.content.subarray(start, end)
      return {
        ok: true,
        value: {
          ...read,
          content,
          offset: read.offset + start,
          truncated: read.truncated || start > 0 || end < read.content.length,
        },
      }
    } catch (error) { return failure(error) }
  }

  async readWorkspaceTextPage(
    workspaceRoot: string,
    requestedPath: string,
    offset: number,
    limit: number | undefined,
    maxBytes: number | undefined,
    authorize: WorkspaceReadAuthorizer,
  ): Promise<JanusResult<WorkspaceTextPage>> {
    try {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new WorkspacePathGuardError('INVALID_READ_LIMIT', 'Workspace file read offset is invalid')
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LINES)) {
        throw new Error(`workspace.read limit must be an integer between 1 and ${MAX_PAGE_LINES}`)
      }
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES)) {
        throw new Error(`workspace.read maxBytes must be an integer between 1 and ${MAX_PAGE_BYTES}`)
      }
      // offset 0 is the pre-line-pages default: forgive it as line 1 instead
      // of failing callers that never set the new 1-indexed base.
      const lineStart = offset === 0 ? 1 : offset
      let buffer: Buffer
      try {
        buffer = await readWorkspaceFile(workspaceRoot, requestedPath, MAX_PAGED_READ_BYTES, authorize)
      } catch (error) {
        if (error instanceof WorkspacePathGuardError && error.code === 'FILE_TOO_LARGE') {
          throw new WorkspacePathGuardError(
            'FILE_TOO_LARGE',
            'Workspace file exceeds the 16MB paged-read ceiling; use workspace.search scoped to this file to locate lines instead of reading it whole',
          )
        }
        throw error
      }
      if (!isTextBuffer(buffer)) throw new Error('Workspace file is not UTF-8 text')
      // Small files return whole from the requested offset: one default call
      // covers the file instead of burning a round trip per page. The hash
      // still covers the full file, so the page stays edit-compatible.
      const adaptive = limit === undefined && maxBytes === undefined && buffer.byteLength <= ADAPTIVE_FULL_FILE_BYTES
      const effectiveLimit = adaptive ? MAX_PAGE_LINES : (limit ?? DEFAULT_PAGE_LINES)
      const effectiveMaxBytes = adaptive ? MAX_PAGE_BYTES : (maxBytes ?? DEFAULT_PAGE_BYTES)
      // Line scan stops at the window: only newline positions are counted over
      // the full buffer (cheap byte scan, no string split), and only the
      // window bytes are decoded. totalLines keeps the historical split('\n')
      // shape (a trailing newline leaves a final empty segment).
      const totalLines = buffer.byteLength === 0 ? 1 : countNewlines(buffer) + 1
      if (lineStart > totalLines) {
        throw new Error(`Offset ${lineStart} is beyond end of file (${totalLines} lines total)`)
      }
      const windowEnd = Math.min(lineStart - 1 + effectiveLimit, totalLines)
      const windowBytes = sliceLineRange(buffer, lineStart, windowEnd)
      const windowText = windowBytes.toString('utf-8')
      const selected = windowText.split('\n')
      // Byte cap wins over the line cap: take the longest prefix that fits.
      const taken: string[] = []
      let takenBytes = 0
      for (const line of selected) {
        const size = Buffer.byteLength(line, 'utf-8') + (taken.length > 0 ? 1 : 0)
        if (takenBytes + size > effectiveMaxBytes) break
        taken.push(line)
        takenBytes += size
      }
      if (taken.length === 0) {
        throw new Error(`Line ${lineStart} exceeds ${effectiveMaxBytes} bytes; re-read with a larger maxBytes (up to 1048576)`)
      }
      const lineEnd = lineStart + taken.length - 1
      const truncated = windowEnd < totalLines || taken.length < selected.length
      const content = Buffer.from(taken.join('\n'), 'utf-8')
      return {
        ok: true,
        value: {
          content,
          lineStart,
          lineEnd,
          totalLines,
          size: buffer.byteLength,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          truncated,
          ...(truncated ? { nextOffset: lineEnd + 1 } : {}),
          bytes: content.byteLength,
        },
      }
    } catch (error) { return failure(error) }
  }

  async collectTextContext(root: string, signal: AbortSignal, options: WorkspaceContextOptions = {}): Promise<JanusResult<string>> {
    const result = await this.collectTextEvidence(root, '', signal, options)
    return result.ok ? { ok: true, value: result.value.context } : result
  }

  async collectTextEvidence(root: string, workspaceId: string, signal: AbortSignal, options: WorkspaceContextOptions = {}): Promise<JanusResult<WorkspaceEvidenceContext>> {
    try {
      const normalizedRoot = await fs.realpath(resolve(root))
      const maxFiles = options.maxFiles ?? 100
      const maxFileBytes = options.maxFileBytes ?? 24 * 1024
      const maxContextBytes = options.maxContextBytes ?? 240 * 1024
      const extensions = options.extensions ?? DEFAULT_EXTENSIONS
      const excludedDirectories = options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES
      const candidates: Array<{ relativePath: string }> = []
      const visit = async (directory: string): Promise<void> => {
        if (signal.aborted || candidates.length >= maxFiles) return
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (signal.aborted || candidates.length >= maxFiles) return
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
          const absolute = resolve(directory, entry.name)
          if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${sep}`)) continue
          const relativePath = relative(normalizedRoot, absolute).replaceAll('\\', '/')
          if (isSensitivePath(relativePath)) continue
          if (entry.isDirectory()) {
            if (!excludedDirectories.has(entry.name)) await visit(absolute)
            continue
          }
          if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue
          candidates.push({ relativePath })
        }
      }
      await visit(normalizedRoot)
      const ignored = await gitIgnoredPaths(normalizedRoot, candidates.map((item) => item.relativePath))
      const git = await gitEvidence(normalizedRoot, candidates.map((item) => item.relativePath))
      const chunks: string[] = []
      const files: BlueprintEvidenceManifest['files'] = []
      let bytes = 0
      for (const candidate of candidates) {
        if (signal.aborted || bytes >= maxContextBytes) break
        if (ignored.has(candidate.relativePath)) continue
        const buffer = await readWorkspaceFile(
          normalizedRoot,
          candidate.relativePath,
          maxFileBytes,
          () => ({ outcome: 'allow', reasonCode: 'MAINTENANCE_SCAN' }),
        ).catch(() => null)
        if (!buffer || !isTextBuffer(buffer)) continue
        const chunk = `\n--- ${candidate.relativePath} ---\n${buffer.toString('utf8')}`
        const chunkBytes = Buffer.byteLength(chunk)
        if (bytes + chunkBytes > maxContextBytes) break
        chunks.push(chunk)
        bytes += chunkBytes
        files.push({
          path: candidate.relativePath,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          role: 'critical',
          sourceState: git.states.get(candidate.relativePath) ?? (git.gitHead ? 'committed' : 'untracked'),
          supportsOperationIds: [],
        })
      }
      const fingerprintInput = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
      const workspaceRootFingerprint = createHash('sha256').update(JSON.stringify([workspaceId, fingerprintInput])).digest('hex')
      return { ok: true, value: { context: chunks.join(''), manifest: { workspaceId, workspaceRootFingerprint, gitHead: git.gitHead, files } } }
    } catch (error) { return failure(error) }
  }
}

export const janusWorkspaceFs = new JanusWorkspaceFs()
