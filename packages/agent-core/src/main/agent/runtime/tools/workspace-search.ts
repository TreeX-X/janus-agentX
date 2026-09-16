import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, matchesGlob } from 'node:path'
import { isSensitivePath, evaluateWorkspaceReadPolicy } from '../policy-gate'
import { readWorkspaceFile } from '../path-guard'
import { isTextBuffer } from '../../environment/janus-workspace-fs'

const SKIP = ['node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.janusX']
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024
const MAX_RESULT_CHARS = 12_000

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

// Note: bounded search preserves complete matches and uses rg when available — see .agents/notes/implemented/bug-fix/2026-09-16-agent-context-search-efficiency.md
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
  const matches: Array<{ path: string; line?: number; text?: string }> = []
  let resultChars = 0
  let resultLimit = false
  const addMatch = (path: string, line?: number, text?: string) => {
    const match = { path, ...(line !== undefined ? { line, text } : {}) }
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
    for (const path of files) {
      if ((options.caseSensitive ? path : path.toLowerCase()).includes(needle) && !addMatch(path)) break
    }
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
        return addMatch(path, event.data.line_number, text.length > 300 ? `${text.slice(0, 300)}…` : text)
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
          && !addMatch(path, index + 1, text.length > 300 ? `${text.slice(0, 300)}…` : text)) break
      }
      if (resultLimit) break
    }
  }
  return {
    matches, scannedFiles, truncated, mode, backend: native ? 'ripgrep' : 'node',
    ...(!native ? { note: 'ripgrep unavailable: bounded Node fallback; ignore files are not applied. Install rg for ignore-aware native search.' } : {}),
    ...(truncated ? { guidance: 'Results are incomplete. Narrow path/glob/query to inspect the remaining matches.' } : {}),
  }
}
