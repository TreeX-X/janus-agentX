import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, matchesGlob } from 'node:path'
import { isSensitivePath, evaluateWorkspaceReadPolicy } from '../policy-gate'
import { readWorkspaceFile, readWorkspaceFileRange } from '../path-guard'
import { DEFAULT_OUTPUT_TOKEN_BUDGET } from './output-budget'
import { isTextBuffer } from '../../environment/janus-workspace-fs'

const SKIP = ['node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.janusX']
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024
/** Record budget ≈ the default output token budget; matches carry ±2 context lines plus a file hash. */
export const MAX_RESULT_CHARS = DEFAULT_OUTPUT_TOKEN_BUDGET * 4
const CONTEXT_LINES = 2
const CONTEXT_READ_BYTES = 1024 * 1024
const HASHABLE_BYTES = 1024 * 1024
const MATCH_TEXT_CHARS = 300

export interface SearchOptions {
  root: string
  path: string
  scopedFile?: string
  query: string
  glob?: string
  mode: 'content' | 'files'
  regex: boolean
  caseSensitive: boolean
  maxResults: number
  signal: AbortSignal
}

/** No shell, no rg config, no symlink traversal; stop producers at the output bound. */
function runRg(args: string[], root: string, signal: AbortSignal, delimiter: string, consume: (record: string) => boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['--no-config', ...args], { cwd: root, windowsHide: true, signal })
    let pending = ''
    let stderr = ''
    let stopped = false
    let missing = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2000) })
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      pending += chunk
      let at: number
      while ((at = pending.indexOf(delimiter)) >= 0) {
        const record = pending.slice(0, at)
        pending = pending.slice(at + delimiter.length)
        try {
          if (record && !consume(record)) { stopped = true; child.kill(); return }
        } catch (error) { stopped = true; child.kill(); reject(error); return }
      }
      if (pending.length > 2 * MAX_BYTES) { stopped = true; child.kill(); reject(new Error('Search record too large; narrow the search path')) }
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.code === 'ENOENT') { missing = true; resolve(false) } else reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (missing) return
      if (signal.aborted) { reject(new Error('workspace.search cancelled')); return }
      if (timedOut) { reject(new Error('Search timed out; narrow path or glob')); return }
      if (!stopped && code !== 0 && code !== 1) { reject(new Error(`Search failed: ${stderr || code}`)); return }
      resolve(true)
    })
  })
}

export interface ContentSearchMatch {
  path: string
  line: number
  text: string
  /** Up to two lines above the hit, truncated like match text; empty at file start. */
  contextBefore: string[]
  /** Up to two lines below the hit, truncated like match text; empty at file end. */
  contextAfter: string[]
  /**
   * Full-file SHA-256, identical to the hash workspace.read returns. Valid as
   * workspace.edit expectedHash while the file is unchanged, so a located
   * fix needs no second read. Omitted for files over 1MB (hashing those is a
   * full read of its own; re-read the file explicitly instead).
   */
  sha256?: string
}

export type SearchMatch = { path: string; line?: number; text?: string } | ContentSearchMatch

export function isContentMatch(match: SearchMatch): match is ContentSearchMatch {
  return typeof (match as ContentSearchMatch).line === 'number'
}

function clipLine(text: string): string {
  return text.length > MATCH_TEXT_CHARS ? `${text.slice(0, MATCH_TEXT_CHARS)}…` : text
}

/**
 * Surrounding lines plus an edit-compatible hash for one matched file. One
 * bounded read (≤1MB) serves the context; the same buffer serves the hash
 * when it holds the whole file. Larger files fall back to a 1MB head read
 * for context only.
 */
async function enrichContentFile(root: string, relativePath: string, lines: number[]): Promise<{ context: Map<number, { before: string[]; after: string[] }>; sha256?: string }> {
  const context = new Map<number, { before: string[]; after: string[] }>()
  let full: Buffer | undefined
  try {
    full = await readWorkspaceFile(root, relativePath, HASHABLE_BYTES, evaluateWorkspaceReadPolicy)
  } catch {
    full = undefined
  }
  let head = full
  if (!head) {
    try {
      const range = await readWorkspaceFileRange(root, relativePath, 0, CONTEXT_READ_BYTES, evaluateWorkspaceReadPolicy)
      head = range.content
    } catch {
      return { context }
    }
  }
  if (!isTextBuffer(head)) return { context }
  const split = head.toString('utf8').split('\n')
  for (const line of lines) {
    const before: string[] = []
    const after: string[] = []
    for (let delta = CONTEXT_LINES; delta >= 1; delta -= 1) {
      const text = split[line - 1 - delta]
      if (text !== undefined) before.push(clipLine(text.replace(/\r$/, '')))
    }
    for (let delta = 1; delta <= CONTEXT_LINES; delta += 1) {
      const text = split[line - 1 + delta]
      if (text !== undefined) after.push(clipLine(text.replace(/\r$/, '')))
    }
    context.set(line, { before, after })
  }
  if (full) return { context, sha256: createHash('sha256').update(full).digest('hex') }
  return { context }
}

/** Recently modified files first; alphabetical order breaks ties. */
async function sortPathsByRecency(root: string, paths: string[]): Promise<string[]> {
  const mtimes = await Promise.all(paths.map(async (path) => {
    try {
      return (await stat(join(root, path))).mtimeMs
    } catch {
      return 0
    }
  }))
  return paths
    .map((path, index) => ({ path, mtime: mtimes[index] ?? 0 }))
    .sort((left, right) => right.mtime - left.mtime || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => entry.path)
}

// Note: bounded search preserves complete matches and uses rg when available — see .agents/notes/implemented/bug-fix/2026-09-16-agent-context-search-efficiency.md
// Note: matches carry context lines, recency order, and edit-compatible hashes — see .agents/notes/implemented/bug-fix/2026-09-16-read-paging-token-amplification.md
export async function searchWorkspace(options: SearchOptions) {
  const { root, signal, query, maxResults, mode } = options
  const files: string[] = []
  let truncated = false
  const eligible = (path: string) => !isSensitivePath(path)
    && !path.split('/').some((part) => SKIP.includes(part))
    && (!options.glob || matchesGlob(path, options.glob))
  const addFile = (raw: string) => {
    const path = raw.replaceAll('\\', '/').replace(/^\.\//, '')
    if (!eligible(path)) return true
    if (files.length >= MAX_FILES) { truncated = true; return false }
    files.push(path)
    return true
  }
  const args = ['--files', '--null', '--hidden', '--no-require-git', '--glob', '!.git', ...SKIP.flatMap((name) => ['--glob', `!${name}`])]
  // Positive rg globs override ignore files; apply user glob after enumeration.
  args.push('--', options.scopedFile ?? (options.path ? `./${options.path}` : '.'))
  const native = await runRg(args, root, signal, '\0', addFile)
  if (!native) {
    if (options.regex) throw new Error('Regex search requires ripgrep (rg); install rg or use a literal query')
    const walk = async (path: string, depth: number): Promise<void> => {
      if (signal.aborted) throw new Error('workspace.search cancelled')
      if (depth > 32) { truncated = true; return }
      const entries = await readdir(join(root, path), { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (signal.aborted) throw new Error('workspace.search cancelled')
        const relative = path ? `${path}/${entry.name}` : entry.name
        if (entry.isSymbolicLink() || isSensitivePath(relative) || SKIP.includes(entry.name)) continue
        if (files.length >= MAX_FILES) { truncated = true; return }
        if (entry.isDirectory()) await walk(relative, depth + 1)
        else if (entry.isFile()) addFile(relative)
      }
    }
    if (options.scopedFile) addFile(options.scopedFile)
    else await walk(options.path, 0)
  }
  files.sort()
  const matches: SearchMatch[] = []
  let resultChars = 0
  let resultLimit = false
  const addMatch = (path: string, line?: number, text?: string) => {
    const match: SearchMatch = { path, ...(line !== undefined ? { line, text } : {}) }
    const cost = JSON.stringify(match).length
    if (matches.length >= maxResults || resultChars + cost > MAX_RESULT_CHARS) {
      truncated = true; resultLimit = true; return false
    }
    matches.push(match)
    resultChars += cost
    return true
  }
  const needle = options.caseSensitive ? query : query.toLowerCase()
  let scannedFiles = 0
  if (mode === 'files') {
    // Collect every name hit before cutting: alphabetical truncation would
    // hide recently modified files behind older names.
    const hits: string[] = []
    for (const path of files) {
      if ((options.caseSensitive ? path : path.toLowerCase()).includes(needle)) hits.push(path)
    }
    const ordered = await sortPathsByRecency(root, hits)
    for (const path of ordered) {
      if (matches.length >= maxResults || resultChars + JSON.stringify({ path }).length > MAX_RESULT_CHARS) {
        if (ordered.length > matches.length) truncated = true
        break
      }
      matches.push({ path })
      resultChars += JSON.stringify({ path }).length
    }
    if (ordered.length > matches.length) truncated = true
  } else if (native) {
    // Explicit eligible paths prevent rg from opening policy-excluded files.
    // Batches stay below Windows command-line limits even with long paths.
    for (let start = 0; start < files.length && !resultLimit;) {
      const batch: string[] = []
      let chars = 0
      while (start < files.length && chars + files[start].length < 6000) {
        const path = files[start++]
        batch.push(`./${path}`); chars += path.length + 4
      }
      if (!batch.length) { truncated = true; start++; continue }
      const searchArgs = ['--json', '--max-filesize', String(MAX_BYTES), '--max-count', String(maxResults + 1)]
      if (!options.caseSensitive) searchArgs.push('--ignore-case')
      if (!options.regex) searchArgs.push('--fixed-strings')
      searchArgs.push('-e', query, '--', ...batch)
      await runRg(searchArgs, root, signal, '\n', (record) => {
        const event = JSON.parse(record)
        if (event.type !== 'match') return true
        const path = event.data.path.text?.replaceAll('\\', '/').replace(/^\.\//, '')
        if (!path || !eligible(path) || typeof event.data.lines.text !== 'string') return true
        const text = event.data.lines.text.replace(/\r?\n$/, '')
        return addMatch(path, event.data.line_number, text.length > MATCH_TEXT_CHARS ? `${text.slice(0, MATCH_TEXT_CHARS)}…` : text)
      })
      scannedFiles += batch.length
    }
  } else {
    for (const path of files) {
      if (signal.aborted) throw new Error('workspace.search cancelled')
      scannedFiles++
      let content: Buffer
      try { content = await readWorkspaceFile(root, path, MAX_BYTES, evaluateWorkspaceReadPolicy) }
      catch { continue }
      if (!isTextBuffer(content)) continue
      for (const [index, text] of content.toString('utf8').split('\n').entries()) {
        if ((options.caseSensitive ? text : text.toLowerCase()).includes(needle)
          && !addMatch(path, index + 1, text.length > MATCH_TEXT_CHARS ? `${text.slice(0, MATCH_TEXT_CHARS)}…` : text)) break
      }
      if (resultLimit) break
    }
  }
  if (mode === 'content') {
    // One enrichment read per matched file: context lines plus the file hash
    // the model can edit against directly.
    const byFile = new Map<string, number[]>()
    for (const match of matches) {
      if (!isContentMatch(match)) continue
      const lines = byFile.get(match.path) ?? []
      lines.push(match.line)
      byFile.set(match.path, lines)
    }
    const enriched = await Promise.all([...byFile].map(async ([path, lines]) => enrichContentFile(root, path, lines)))
    const enrichment = new Map([...byFile.keys()].map((path, index) => [path, enriched[index]!]))
    for (const match of matches) {
      if (!isContentMatch(match)) continue
      const entry = enrichment.get(match.path)
      const seen = entry?.context.get(match.line)
      match.contextBefore = seen?.before ?? []
      match.contextAfter = seen?.after ?? []
      if (entry?.sha256) match.sha256 = entry.sha256
    }
    // Context and hashes land after the pre-cap: trim back into budget so one
    // call never exceeds MAX_RESULT_CHARS regardless of line lengths.
    while (matches.length > 1 && JSON.stringify(matches).length > MAX_RESULT_CHARS) {
      matches.pop()
      truncated = true
    }
  }
  return {
    matches, scannedFiles, truncated, mode, backend: native ? 'ripgrep' : 'node',
    ...(!native ? { note: 'ripgrep unavailable: bounded Node fallback; ignore files are not applied. Install rg for ignore-aware native search.' } : {}),
    ...(truncated ? { guidance: 'Results are incomplete. Narrow path/glob/query to inspect the remaining matches.' } : {}),
  }
}
