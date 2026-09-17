import type { ToolResult } from '../../../shared/ipc/agent-runtime'
import { truncateModelText } from './tools/output-budget'

// Note: opencode-style plain-text model values live here — see .agents/notes/implemented/architecture/2026-09-17-opencode-token-parity.md
// Structured runtime outputs stay complete in details/traces/UI; only the
// text the model re-reads every turn is capped via truncateModelText.

function shortSha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * P4 preview-only: command.run sync stdout/stderr are already 8KB tail
 * previews with the full log at logPath. Plain text (opencode parity):
 * refs first as header lines, preview bodies last. Structured fields stay
 * in details/traces; the model only re-reads this text.
 */
function commandRunModelValue(output: Record<string, unknown>): string {
  const lines: string[] = []
  const program = typeof output.program === 'string' ? output.program : ''
  const args = Array.isArray(output.args) ? output.args.map(String).join(' ') : ''
  const cmd = `${program}${args ? ` ${args}` : ''}`.trim() || 'command'
  const exit = typeof output.exitCode === 'number' ? ` exit=${output.exitCode}` : ''
  const timedOut = output.timedOut === true ? ' timedOut' : ''
  lines.push(`$ ${cmd}${exit}${timedOut}`)
  const logPath = typeof output.logPath === 'string' ? output.logPath : undefined
  const totalBytes = typeof output.totalBytes === 'number' ? output.totalBytes : undefined
  if (output.background === true && typeof output.projectId === 'string') {
    lines.push(`job=${output.projectId}${logPath ? ` log=${logPath}` : ''}`)
    lines.push('Background job started. Poll project_process_output with the projectId above; increase offsetLines to read earlier lines. Do NOT re-run the command to poll.')
    return lines.join('\n')
  }
  if (logPath) {
    lines.push(`Full log at ${logPath}${totalBytes !== undefined ? ` (${totalBytes} bytes total)` : ''}; stdout/stderr below are 8KB tail previews. Read the log with workspace_read (offset/limit) for earlier errors such as TSxxxx. Do NOT re-run the command to see more output.`)
  }
  if (output.stdout !== undefined) lines.push(`<stdout>\n${String(output.stdout)}</stdout>`)
  if (output.stderr !== undefined) lines.push(`<stderr>\n${String(output.stderr)}</stderr>`)
  return truncateModelText(
    lines.join('\n'),
    `Read the full log at ${logPath ?? 'logPath'} with workspace_read instead of re-running.`,
  )
}

/**
 * P4 preview-only: project.process-output pages are already bounded.
 * Plain text: paging refs as one header line, page blob last.
 */
function processOutputModelValue(output: Record<string, unknown>): string {
  const totalLines = typeof output.totalLines === 'number' ? output.totalLines : '?'
  const offsetLines = typeof output.offsetLines === 'number' ? output.offsetLines : 0
  const header = [
    typeof output.projectId === 'string' ? `job=${output.projectId}` : '',
    `lines=${offsetLines}/${totalLines}`,
    output.truncated === true ? 'truncated' : '',
    output.exited === true ? `exited=${String(output.exitCode)}` : '',
    output.timedOut === true ? 'timedOut' : '',
    typeof output.logPath === 'string' ? `log=${output.logPath}` : '',
  ].filter(Boolean).join(' ')
  const lines = [header || 'process output']
  if (output.truncated === true) {
    lines.push(`Output is paged (${String(totalLines)} lines total). Increase offsetLines to read earlier lines. Do NOT re-run the command.`)
  }
  lines.push(String(output.output ?? ''))
  return truncateModelText(
    lines.join('\n'),
    'Page with a larger offsetLines instead of re-running.',
  )
}

/**
 * P4 preview-only: workspace.read pages are already bounded. Plain text
 * (opencode `N: line` parity): one header line with range + full sha for
 * edits, then numbered lines. Drops workspaceId/bytes/size/token echoes;
 * those stay in details/traces. Paging hint only when truncated.
 */
function workspaceReadModelValue(output: Record<string, unknown>): string {
  const path = typeof output.path === 'string' ? output.path : 'file'
  const lineStart = typeof output.lineStart === 'number' ? output.lineStart : (typeof output.offset === 'number' ? output.offset : 1)
  const lineEnd = typeof output.lineEnd === 'number' ? output.lineEnd : lineStart
  const totalLines = typeof output.totalLines === 'number' ? `/${output.totalLines}` : ''
  const sha = shortSha(output.sha256)
  const header = [`<path>${path}</path>`, `lines ${lineStart}-${lineEnd}${totalLines}`, ...(sha ? [`sha=${sha}`] : [])].join(' ')
  const lines = [header, '<content>']
  const raw = typeof output.content === 'string' ? output.content : ''
  const numbered = raw.split('\n').map((line, index) => `${lineStart + index}: ${line}`)
  lines.push(numbered.join('\n'))
  lines.push('</content>')
  if (output.truncated === true && typeof output.nextOffset === 'number') {
    lines.push(`(Showing lines ${lineStart}-${lineEnd}${totalLines}. Use workspace_read with offset=${output.nextOffset} to continue. Do NOT re-read offset=1.)`)
  }
  if (output.contentRedacted === true) {
    lines.push(typeof output.redactionNotice === 'string' && output.redactionNotice
      ? output.redactionNotice
      : 'High-confidence credential material was masked as [REDACTED].')
  }
  return truncateModelText(lines.join('\n'), `Re-read ${path} with a narrower offset/limit.`)
}

function workspaceSearchModelValue(output: Record<string, unknown>): string {
  const matches = Array.isArray(output.matches) ? output.matches as Array<Record<string, unknown>> : []
  const query = typeof output.query === 'string' && output.query ? ` for "${output.query.slice(0, 80)}"` : ''
  const hits = matches.reduce((total, match) => total + (typeof match.matchCount === 'number' ? match.matchCount : 1), 0)
  const lines = [`Found ${hits} match${hits === 1 ? '' : 'es'}${query}`]
  let currentFile = ''
  const pushFileHeader = (path: string, sha: string | undefined, extra?: string) => {
    lines.push('')
    lines.push(`${path}:${extra ? ` ${extra}` : ''}${sha ? ` [sha=${sha}]` : ''}`)
  }
  for (const match of matches) {
    const path = typeof match.path === 'string' ? match.path : undefined
    if (!path) continue
    if (Array.isArray((match as { hunks?: unknown }).hunks)) {
      const grouped = match as { matchCount?: number; sha256?: unknown; hunks: Array<{ lines: Array<{ line: number; text: string; hit: boolean }> }> }
      const sha = shortSha(grouped.sha256)
      pushFileHeader(path, sha, typeof grouped.matchCount === 'number' ? `(${grouped.matchCount} matches)` : undefined)
      for (const hunk of grouped.hunks) {
        for (const entry of hunk.lines) {
          lines.push(`${entry.hit ? '>' : ' '} Line ${entry.line}: ${entry.text}`)
        }
      }
      currentFile = path
      continue
    }
    if (typeof match.line === 'number') {
      const sha = shortSha((match as { sha256?: unknown }).sha256)
      if (currentFile !== path) {
        pushFileHeader(path, currentFile === '' || sha ? sha : undefined)
        currentFile = path
      }
      lines.push(` Line ${match.line}: ${typeof match.text === 'string' ? match.text : ''}`)
      continue
    }
    lines.push(path)
    currentFile = path
  }
  if (matches.length === 0) return lines.join('\n')
  if (output.truncated === true) {
    lines.push('')
    lines.push('(Results are incomplete. Narrow path/glob/query to inspect the remaining matches. Do NOT re-run the same broad query.)')
  }
  return truncateModelText(lines.join('\n'), 'Re-search with a narrower path/glob/query.')
}

function workspaceListModelValue(output: Record<string, unknown>): string {
  const entries = Array.isArray(output.entries) ? output.entries as Array<Record<string, unknown>> : []
  const path = typeof output.path === 'string' && output.path ? output.path : '.'
  const lines = [`<path>${path}</path>`, '<entries>']
  for (const entry of entries) {
    if (typeof entry.path !== 'string') continue
    const type = entry.type === 'directory' ? '/' : ''
    const size = typeof entry.size === 'number' && entry.type !== 'directory' ? ` (${entry.size}b)` : ''
    lines.push(`${entry.path}${type}${size}`)
  }
  lines.push(`(${entries.length} entries)`)
  lines.push('</entries>')
  if (output.truncated === true) {
    lines.push('(Truncated. Re-list with a deeper path or a smaller maxEntries.)')
  }
  if (typeof output.path === 'string' && (output as Record<string, unknown>).git !== undefined) {
    const git = (output as Record<string, unknown>).git as Record<string, unknown>
    lines.push(`git: ${String(git.branch ?? 'unknown')} +${String(git.staged ?? 0)} ~${String(git.unstaged ?? 0)} ?${String(git.untracked ?? 0)}`)
  }
  return truncateModelText(lines.join('\n'), 'Re-list with a deeper path or a smaller maxEntries.')
}

function workspaceMutationModelValue(toolName: string, output: Record<string, unknown>): string {
  const path = typeof output.path === 'string' ? output.path : 'file'
  const sha = shortSha(output.sha256)
  const checkpoint = typeof output.checkpointId === 'string' ? ` checkpoint=${output.checkpointId}` : ''
  const head = toolName === 'workspace.create' ? `Created ${path}`
    : toolName === 'workspace.delete'
      ? `Deleted ${path}${typeof output.kind === 'string' ? ` (${output.kind}${typeof output.entryCount === 'number' && output.entryCount > 0 ? `, ${output.entryCount} entries` : ''})` : ''}`
      : `Edited ${path}`
  return `${head}${sha ? ` sha=${sha}` : ''}${checkpoint}`
}

export function toolResultToModelValue(result: ToolResult): unknown {
  if (result.status === 'completed') {
    const output = asRecord(result.output)
    if (output && result.toolName === 'command.run') return commandRunModelValue(output)
    if (output && result.toolName === 'project.process-output') return processOutputModelValue(output)
    if (output && result.toolName === 'workspace.read') return workspaceReadModelValue(output)
    if (output && result.toolName === 'workspace.search') return workspaceSearchModelValue(output)
    if (output && (result.toolName === 'workspace.list' || result.toolName === 'workspace.overview')) {
      return workspaceListModelValue(output)
    }
    // Mutation results: one-line summary. Full hashes, diffs, and
    // checkpoints ride the full ToolResult to traces/UI; the model already
    // holds the bytes it sent.
    if (output && (result.toolName === 'workspace.edit' || result.toolName === 'workspace.create' || result.toolName === 'workspace.delete')) {
      return workspaceMutationModelValue(result.toolName, output)
    }
    return result.output
  }
  if (result.reasonCode === 'APPROVAL_DENIED') {
    return {
      ok: false,
      status: result.status,
      reasonCode: result.reasonCode,
      userDenied: true,
      guidance: 'The user declined this action in the approval dialog. Do not retry it; acknowledge the decision and continue helping.',
    }
  }
  if (result.reasonCode === 'TARGET_CHANGED') {
    return {
      ok: false,
      status: result.status,
      reasonCode: result.reasonCode,
      retryable: true,
      error: result.error || `${result.toolName} ${result.status}`,
      guidance: 'The file changed during this read attempt. The workspace is not locked. Call workspace_read once more to obtain the current content and SHA-256 before editing.',
    }
  }
  return {
    ok: false,
    status: result.status,
    reasonCode: result.reasonCode,
    error: result.error || `${result.toolName} ${result.status}`,
  }
}
