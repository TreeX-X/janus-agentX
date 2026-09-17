import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, matchesGlob } from 'node:path'
import { isSensitivePath, evaluateWorkspaceReadPolicy } from '../policy-gate'
import { readWorkspaceFile, readWorkspaceFileRange } from '../path-guard'
import { DEFAULT_OUTPUT_TOKEN_BUDGET } from './output-budget'
import { isTextBuffer } from '../../environment/janus-workspace-fs'

const SKIP = ['node_modules', 'dist', 'out', 'build', 'release', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.janusX']
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024
/**
 * Best-effort rg-side exclusions mirroring SKIP plus the sensitive
 * directories/filenames/extensions from policy-gate. Result-side eligible()
 * stays authoritative; these globs only avoid opening excluded files during
 * single-passthrough scans.
 */
const SENSITIVE_GLOBS = [
  '.aws', '.azure', '.gnupg', '.kube', '.secrets', '.ssh', 'secrets',
  '.env', '.envrc', '.git-credentials', '.netrc', '.npmrc', '.pypirc',
  'credentials', 'credentials.json', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa',
  '*.jks', '*.key', '*.keystore', '*.p12', '*.pem', '*.pfx',
]
const RG_EXCLUDE_GLOBS = ['.git', ...SKIP, ...SENSITIVE_GLOBS]
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
  /**
   * Hit-first by default (flat {path, line, text}). Pass true to group hits
   * per file into hunks with ±2 context lines plus the edit-compatible
   * file hash (costs one bounded read per matched file).
   */
  withContext?: boolean
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

export interface SearchHunkLine {
  line: number
  text: string
  hit: boolean
}

export interface SearchHunk {
  start: number
  end: number
  /** Elided lines between this hunk and the previous one; omitted on the first hunk. */
  gapBefore?: number
  lines: SearchHunkLine[]
}

export interface ContentFileGroup {
  path: string
  /** Hits shown in this file; hunks merge their overlapping context windows. */
  matchCount: number
  hunks: SearchHunk[]
  /**
   * Full-file SHA-256, identical to the hash workspace.read returns. Valid as
   * workspace.edit expectedHash while the file is unchanged, so a located
   * fix needs no second read. Omitted for files over 1MB (hashing those is a
   * full read of its own; re-read the file explicitly instead).
   */
  sha256?: string
}

export type SearchMatch = { path: string; line?: number; text?: string; sha256?: string } | ContentFileGroup

export function isContentMatch(match: SearchMatch): match is ContentFileGroup {
  return Array.isArray((match as ContentFileGroup).hunks)
}

/** Hits shown across file groups (flat files-mode matches count one each). */
export function countSearchHits(matches: SearchMatch[]): number {
  return matches.reduce((total, match) => total + (isContentMatch(match) ? match.matchCount : 1), 0)
}

/** First hit line of a group for one-line digests; undefined when hunks are empty. */
export function firstGroupHitLine(group: ContentFileGroup): number | undefined {
  for (const hunk of group.hunks) {
    for (const line of hunk.lines) {
      if (line.hit) return line.line
    }
  }
  return undefined
}

function clipLine(text: string): string {
  return text.length > MATCH_TEXT_CHARS ? `${text.slice(0, MATCH_TEXT_CHARS)}…` : text
}

/**
 * One bounded read per matched file. The same buffer serves hunk context and
 * the edit-compatible hash when it holds the whole file (≤1MB); larger files
 * fall back to a 1MB head read for context only.
 */
async function readContentFile(root: string, relativePath: string): Promise<{ lines: string[]; sha256?: string } | undefined> {
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
      return undefined
    }
  }
  if (!isTextBuffer(head)) return undefined
  const lines = head.toString('utf8').split('\n')
  if (full) return { lines, sha256: createHash('sha256').update(full).digest('hex') }
  return { lines }
}

/** Gaps of at most this many unseen lines absorb into the hunk instead of a marker. */
const HUNK_ABSORB_GAP = 2

/**
 * Merge per-hit ±2-line windows into hunks. Overlapping or touching windows
 * join silently; tiny gaps absorb as plain context; larger skips become an
 * explicit gapBefore count so the model sees the discontinuity without
 * paying for the elided lines.
 */
function buildHunks(fileLines: string[], hits: Array<{ line: number; text: string }>): SearchHunk[] {
  const sorted = [...hits].sort((a, b) => a.line - b.line)
  const ranges: Array<{ start: number; end: number; hitText: Map<number, string> }> = []
  for (const hit of sorted) {
    const start = Math.max(1, hit.line - CONTEXT_LINES)
    const end = hit.line + CONTEXT_LINES
    const current = ranges[ranges.length - 1]
    if (current && start <= current.end + 1 + HUNK_ABSORB_GAP) {
      current.end = Math.max(current.end, end)
      if (!current.hitText.has(hit.line)) current.hitText.set(hit.line, hit.text)
    } else {
      ranges.push({ start, end, hitText: new Map([[hit.line, hit.text]]) })
    }
  }
  let previousEnd = 0
  const hunks: SearchHunk[] = []
  for (const range of ranges) {
    const gapBefore = previousEnd === 0 ? undefined : range.start - previousEnd - 1
    const lines: SearchHunkLine[] = []
    for (let line = range.start; ; line += 1) {
      const raw = fileLines[line - 1]
      const hitText = range.hitText.get(line)
      // The file shifted between the rg scan and this read: keep the hit
      // text the scanner saw instead of dropping the evidence.
      if (raw === undefined && hitText === undefined) break
      // A trailing newline leaves a final empty segment; as context it is
      // noise, so the hunk ends before it (hits there stay, see above).
      if (raw === '' && hitText === undefined && line === fileLines.length && line > 1) break
      lines.push({ line, text: clipLine(((hitText ?? raw ?? '').replace(/\r$/, ''))), hit: hitText !== undefined })
      if (line >= range.end && raw !== undefined) break
    }
    if (lines.length > 0) {
      hunks.push({
        start: lines[0]!.line,
        end: lines[lines.length - 1]!.line,
        ...(gapBefore === undefined || gapBefore <= 0 ? {} : { gapBefore }),
        lines,
      })
      previousEnd = lines[lines.length - 1]!.line
    }
  }
  return hunks
}

/** Single rg --files enumeration shared by files-mode and the Node fallback. */
async function enumerateFiles(options: SearchOptions): Promise<{ files: string[]; truncated: boolean; native: boolean }> {
  const { root, signal } = options
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
  const args = ['--files', '--null', '--hidden', '--no-require-git', ...RG_EXCLUDE_GLOBS.flatMap((name) => ['--glob', `!${name}`])]
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
  return { files, truncated, native }
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

/**
 * Content-order pass: recently modified files first, hits within a file keep
 * collection order (stable sort). Only matched files are stated, so the cost
 * stays bounded by maxResults instead of the repository size.
 */
// Note: flat first-hit hashes and recency order cut re-reads — see .agents/notes/implemented/architecture/2026-09-17-turn-ritual-history-replay.md
async function orderContentMatchesByRecency(root: string, matches: SearchMatch[]): Promise<void> {
  const distinct: string[] = []
  for (const match of matches) {
    if (isContentMatch(match) || typeof match.line !== 'number') continue
    if (!distinct.includes(match.path)) distinct.push(match.path)
  }
  if (distinct.length < 2) return
  const mtimes = await Promise.all(distinct.map(async (path) => {
    try {
      return (await stat(join(root, path))).mtimeMs
    } catch {
      return 0
    }
  }))
  // Stable sort by mtime only: ties (including unknown files) keep the
  // scanner's collection order instead of falling back to alphabetical.
  const rank = new Map(distinct
    .map((path, index) => ({ path, mtime: mtimes[index] ?? 0 }))
    .sort((left, right) => right.mtime - left.mtime)
    .map((entry, index) => [entry.path, index] as [string, number]))
  matches.sort((left, right) => {
    const leftPath = isContentMatch(left) ? '' : left.path
    const rightPath = isContentMatch(right) ? '' : right.path
    return (rank.get(leftPath) ?? 0) - (rank.get(rightPath) ?? 0)
  })
}

/**
 * Hash the first flat hit per file (≤1MB, policy-readable). Hashing is
 * server-side IO: ~16 tokens per file on the wire, while a compensating
 * re-read before edit costs a full page plus a turn.
 */
async function attachFirstHitHashes(root: string, matches: SearchMatch[]): Promise<void> {
  const seen = new Set<string>()
  const firsts: Array<{ path: string; match: { path: string; line?: number; text?: string; sha256?: string } }> = []
  for (const match of matches) {
    if (isContentMatch(match) || typeof match.line !== 'number' || seen.has(match.path)) continue
    seen.add(match.path)
    firsts.push({ path: match.path, match })
  }
  const hashes = await Promise.all(firsts.map(async ({ path }) => {
    try {
      const full = await readWorkspaceFile(root, path, HASHABLE_BYTES, evaluateWorkspaceReadPolicy)
      return createHash('sha256').update(full).digest('hex')
    } catch {
      return undefined
    }
  }))
  firsts.forEach(({ match }, index) => {
    const sha256 = hashes[index]
    if (sha256 !== undefined) match.sha256 = sha256
  })
}

// Note: bounded search preserves complete matches and uses rg when available — see .agents/notes/implemented/bug-fix/2026-09-16-agent-context-search-efficiency.md
// Note: matches carry context lines, recency order, and edit-compatible hashes — see .agents/notes/implemented/bug-fix/2026-09-16-read-paging-token-amplification.md
// Note: first hit is a single rg passthrough with flat matches; hunks and hashes are opt-in — see .agents/notes/implemented/architecture/2026-09-17-search-first-token-optimization.md
export async function searchWorkspace(options: SearchOptions) {
  const { root, signal, query, maxResults, mode } = options
  const withContext = options.withContext === true
  const eligible = (path: string) => !isSensitivePath(path)
    && !path.split('/').some((part) => SKIP.includes(part))
    && (!options.glob || matchesGlob(path, options.glob))
  const matches: SearchMatch[] = []
  let resultChars = 0
  let resultLimit = false
  let truncated = false
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
    const { files, truncated: enumTruncated, native } = await enumerateFiles(options)
    truncated = enumTruncated
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
    return {
      matches, scannedFiles: files.length, truncated, mode, backend: native ? 'ripgrep' : 'node',
      ...(!native ? { note: 'ripgrep unavailable: bounded Node fallback; ignore files are not applied. Install rg for ignore-aware native search.' } : {}),
      ...(truncated ? { guidance: 'Results are incomplete. Narrow path/glob/query to inspect the remaining matches.' } : {}),
    }
  }
  // Content mode: one rg process over the scope. The user glob stays
  // result-side (positive rg globs override ignore files); rg-side
  // exclusions are best-effort so excluded files are never opened by choice,
  // while eligible() remains authoritative for what the model sees.
  const scope = options.scopedFile ?? (options.path ? `./${options.path}` : '.')
  const searchArgs = ['--json', '--hidden', '--no-require-git', '--max-filesize', String(MAX_BYTES), '--max-count', String(maxResults + 1),
    ...RG_EXCLUDE_GLOBS.flatMap((name) => ['--glob', `!${name}`])]
  if (!options.caseSensitive) searchArgs.push('--ignore-case')
  if (!options.regex) searchArgs.push('--fixed-strings')
  searchArgs.push('-e', query, '--', scope)
  const native = await runRg(searchArgs, root, signal, '\n', (record) => {
    const event = JSON.parse(record)
    if (event.type === 'end') { scannedFiles += 1; return true }
    if (event.type !== 'match') return true
    const path = event.data.path.text?.replaceAll('\\', '/').replace(/^\.\//, '')
    if (!path || !eligible(path) || typeof event.data.lines.text !== 'string') return true
    const text = event.data.lines.text.replace(/\r?\n$/, '')
    return addMatch(path, event.data.line_number, text.length > MATCH_TEXT_CHARS ? `${text.slice(0, MATCH_TEXT_CHARS)}…` : text)
  })
  if (!native) {
    if (options.regex) throw new Error('Regex search requires ripgrep (rg); install rg or use a literal query')
    const { files, truncated: enumTruncated } = await enumerateFiles(options)
    truncated = truncated || enumTruncated
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
  await orderContentMatchesByRecency(root, matches)
  if (!withContext) {
    // First hit per file carries the edit-compatible hash so a located fix
    // usually needs no second read; grouping stays opt-in via withContext.
    await attachFirstHitHashes(root, matches)
    return {
      matches, scannedFiles, truncated, mode, backend: native ? 'ripgrep' : 'node',
      ...(!native ? { note: 'ripgrep unavailable: bounded Node fallback; ignore files are not applied. Install rg for ignore-aware native search.' } : {}),
      ...(truncated ? { guidance: 'Results are incomplete. Narrow path/glob/query to inspect the remaining matches.' } : {}),
    }
  }
  if (mode === 'content') {
    // Group hits per file and merge overlapping context windows into hunks:
    // clustered hits share one context copy plus one file hash instead of
    // repeating both per hit, and distant hunks carry an explicit gap count.
    const hitsByFile = new Map<string, Array<{ line: number; text: string }>>()
    for (const match of matches) {
      // Collection-phase hits are flat {path, line, text}; groups only exist
      // after this block runs.
      if (isContentMatch(match) || typeof match.line !== 'number' || typeof match.text !== 'string') continue
      const hits = hitsByFile.get(match.path) ?? []
      hits.push({ line: match.line, text: match.text })
      hitsByFile.set(match.path, hits)
    }
    const contents = await Promise.all([...hitsByFile].map(async ([path]) => readContentFile(root, path)))
    const grouped: SearchMatch[] = []
    for (const [index, [path, hits]] of [...hitsByFile].entries()) {
      const content = contents[index]
      if (!content) continue
      const hunks = buildHunks(content.lines, hits)
      if (hunks.length === 0) continue
      grouped.push({
        path,
        matchCount: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.hit).length, 0),
        hunks,
        ...(content.sha256 === undefined ? {} : { sha256: content.sha256 }),
      })
    }
    matches.length = 0
    matches.push(...grouped)
    // Hunks land after the flat pre-cap: trim trailing hunks back into
    // budget so one call never exceeds MAX_RESULT_CHARS. Match counts follow
    // the shown hunks; emptied groups drop.
    while (countSearchHits(matches) > 0 && JSON.stringify(matches).length > MAX_RESULT_CHARS) {
      const last = matches[matches.length - 1]!
      if (!isContentMatch(last)) {
        if (matches.length <= 1) break
        matches.pop()
        truncated = true
        continue
      }
      if (last.hunks.length <= 1) {
        if (matches.length <= 1) break
        matches.pop()
        truncated = true
        continue
      }
      last.hunks.pop()
      last.matchCount = last.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.hit).length, 0)
      truncated = true
    }
  }
  return {
    matches, scannedFiles, truncated, mode, backend: native ? 'ripgrep' : 'node',
    ...(!native ? { note: 'ripgrep unavailable: bounded Node fallback; ignore files are not applied. Install rg for ignore-aware native search.' } : {}),
    ...(truncated ? { guidance: 'Results are incomplete. Narrow path/glob/query to inspect the remaining matches.' } : {}),
  }
}
