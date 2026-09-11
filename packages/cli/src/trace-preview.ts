/**
 * @file Post-turn file-change previews for tool cards (no React/Ink).
 * @description After a turn resolves, `ChatTurnResult.toolTraces` carries a
 * compact `summary` per executed tool (path + sha, match counts, edit notes).
 * For file mutations (`workspace.edit/create/delete`) this module additionally reads
 * a bounded `git diff` (or new-file content) so cards render a real preview
 * under the outcome line — pi/opencode style. Deleted tracked files render
 * their deletion diff; deleted untracked files degrade to the summary line. Everything is best-effort and
 * synchronous: any failure degrades to the summary line. Reads stay inside
 * the workspace root; output is already-bounded display text.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ChatToolTraceEntry } from '@janus-agent/chat-core'

export interface TracePreview {
  toolName: string
  summary: string
  /** Compact diff/content lines (may be empty → summary-only card). */
  diff: string[]
}

const MUTATION_TOOLS = new Set(['workspaceedit', 'workspacecreate', 'workspacedelete'])
const MAX_DIFF_LINES = 24
const MAX_LINE_CHARS = 240
const MAX_NEW_FILE_LINES = 12

function normalizeToolName(name: string): string {
  return name.replace(/[._-]+/g, '').toLowerCase()
}

function runGit(workspaceRoot: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', workspaceRoot, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof output === 'string' ? output : String(output)
  } catch {
    return null
  }
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
}

/** Drop diff headers, bound lines, append a (+a -d) stat line when computable. */
function formatDiff(raw: string): string[] {
  const content: string[] = []
  let added = 0
  let deleted = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file')
      || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('Binary ')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) deleted += 1
    else if (!line.startsWith('@@')) continue
    content.push(truncateLine(line))
  }
  const shown = content.slice(0, MAX_DIFF_LINES)
  if (content.length > MAX_DIFF_LINES) shown.push(`… (${content.length - MAX_DIFF_LINES} more)`)
  if (added > 0 || deleted > 0) shown.push(`(+${added} -${deleted})`)
  return shown
}

/**
 * Bounded preview for one mutated path: tracked diff, else new-file content,
 * else empty (non-repo edit without a baseline → summary-only card).
 */
export function previewFileChange(workspaceRoot: string, path: string, opts: { isNew?: boolean } = {}): string[] {
  const absolute = resolve(workspaceRoot, path)
  if (absolute !== workspaceRoot && !absolute.startsWith(workspaceRoot + sep)) return []
  const diff = runGit(workspaceRoot, ['diff', '--no-color', '--unified=2', '--', path])
  if (diff && diff.trim()) return formatDiff(diff)
  const status = runGit(workspaceRoot, ['status', '--porcelain', '--', path])
  if (status && status.startsWith('??')) return readNewFile(absolute)
  // Outside any repo there is no status signal: only creates have a known baseline.
  if (!status && opts.isNew) return readNewFile(absolute)
  return []
}

function readNewFile(absolute: string): string[] {
  try {
    if (!existsSync(absolute)) return []
    const content = readFileSync(absolute, 'utf8').split('\n')
    if (content.length > 0 && content[content.length - 1] === '') content.pop()
    const shown = content.slice(0, MAX_NEW_FILE_LINES).map((line) => `+${truncateLine(line)}`)
    if (content.length > MAX_NEW_FILE_LINES) shown.push(`… (${content.length - MAX_NEW_FILE_LINES} more)`)
    shown.push(`(+${content.length} -0, new file)`)
    return shown
  } catch {
    return []
  }
}

export function buildTracePreviews(workspaceRoot: string, traces: ChatToolTraceEntry[]): TracePreview[] {
  return (traces ?? [])
    .filter((trace) => trace && typeof trace.toolName === 'string')
    .map((trace) => {
      const summary = trace.summary?.trim() || trace.toolName
      const path = typeof trace.argsDigest === 'string' && trace.argsDigest ? trace.argsDigest : undefined
      const normalized = normalizeToolName(trace.toolName)
      const diff = path && MUTATION_TOOLS.has(normalized)
        ? previewFileChange(workspaceRoot, path, { isNew: normalized === 'workspacecreate' })
        : []
      return { toolName: trace.toolName, summary, diff }
    })
}
