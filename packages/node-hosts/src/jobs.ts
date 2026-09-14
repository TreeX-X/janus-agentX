/**
 * @file In-process background job manager for host command execution.
 * @description Minimal replacement for the JanusX ProjectRunner adhoc channel:
 * detached-ish spawn (unref'd so a CLI can exit), append-only disk log under
 * `<workspace>/.janusX/logs/`, opt-in timeout kill with SIGTERM→SIGKILL
 * escalation, exit snapshots and offset paging. No Electron dependency.
 *
 * Ownership: one JobManager per host session (CLI: per CliSession, disposed
 * on close). Records are bounded (MAX_JOBS); unknown ids fail closed with a
 * model-readable error.
 */
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { commandExecutionMode, WINDOWS_SHELL_META } from './windows-shell.js'

// Note: background spawn shares the Windows shell shim with sync command.run — see .agents/notes/implemented/bug-fix/2026-09-13-background-jobs-windows-shell-shim.md

const LOG_DIR = '.janusX/logs'
/** P4-tail mirror: keep the last N exited snapshots queryable. */
const MAX_JOBS = 20
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
const KILL_ESCALATION_MS = 5_000
const STOP_WAIT_MS = 10_000

export function spawnHint(program: string): string {
  return `hint: the program '${program}' failed to start (ENOENT reads as a negative exit such as -4058 on Windows).`
    + ` Launch the host from a shell with Node on PATH; package-manager shims resolve through cmd.exe on win32.`
}

/**
 * Best-effort win32 process-tree pre-kill. Console processes ignore a graceful
 * terminate and the previous handle kill was TerminateProcess anyway, so the
 * tree is always forced; failures fall through to the caller's handle kill.
 * Shared by background jobs and the sync command.run timeout/abort path.
 */
export function tryTreeKill(pid: unknown): void {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid)) return
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    spawnSync(`${systemRoot}\\System32\\taskkill.exe`,
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 })
  } catch {
    // Best effort: the handle-kill flow covers the miss.
  }
}

export interface JobStartInput {
  /** Absolute workspace root (log dir + jail anchor). */
  workspaceRoot: string
  /** Absolute working directory (already jail-checked by the caller). */
  cwd: string
  /** Workspace-relative display path for the cwd. */
  cwdDisplay: string
  program: string
  args: string[]
  env: Record<string, string>
  /** Human label for list output. */
  label: string
  /** Explicit opt-in deadline; absent = no deadline (shell P3 history). */
  timeoutMs?: number
}

export interface JobStarted {
  projectId: string
  pid?: number
  name: string
  /** Workspace-relative log path (page it with workspace_read). */
  logPath: string
  timeoutMs?: number
}

export interface JobPage {
  projectId: string
  totalLines: number
  offsetLines: number
  truncated: boolean
  output: string[]
  exited: boolean
  exitCode?: number | null
  signal?: string | null
  timedOut: boolean
  logPath: string
}

export interface JobStopped {
  projectId: string
  stopped: boolean
  exited: boolean
  exitCode?: number | null
  signal?: string | null
  timedOut: boolean
}

export interface JobSummary {
  projectId: string
  name: string
  pid?: number
  running: boolean
  exitCode?: number | null
  timedOut: boolean
}

interface JobRecord {
  projectId: string
  name: string
  pid?: number
  child: ChildProcess
  logAbsPath: string
  logRelPath: string
  handle: FileHandle | null
  /** Serializes all log writes: FileHandle has a shared position, so
   * concurrent un-awaited writes would interleave/corrupt the log. */
  queue: Promise<void>
  totalBytes: number
  logCapped: boolean
  exited: boolean
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutTimer: NodeJS.Timeout | null
  startedAt: number
  endedAt?: number
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>()

  async start(input: JobStartInput): Promise<JobStarted> {
    const projectId = `bg-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const name = input.label.slice(0, 120) || input.program
    const executionMode = commandExecutionMode(input.program)
    const useShell = executionMode === 'windows-shell-shim'
    if (useShell && input.args.some((arg) => WINDOWS_SHELL_META.test(arg))) {
      throw new Error('command.run shell-backed arguments contain unsupported metacharacters')
    }
    await mkdir(join(input.workspaceRoot, LOG_DIR), { recursive: true })
    const logName = `${projectId}.log`
    const logAbsPath = join(input.workspaceRoot, LOG_DIR, logName)
    const logRelPath = `${LOG_DIR}/${logName}`
    const header = [
      `# background job ${projectId} (${name})`,
      `# program: ${input.program} ${input.args.join(' ')}`.trimEnd(),
      `# cwd: ${input.cwdDisplay || '.'}`,
      `# started: ${new Date().toISOString()}`,
      `# executionMode: ${executionMode}`,
      ...(input.timeoutMs === undefined ? [] : [`# timeoutMs: ${input.timeoutMs}`]),
      '--- output ---',
    ].join('\n')
    const handle = await open(logAbsPath, 'w')

    let child
    try {
      child = spawn(input.program, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await handle.write(`${header}\nspawn error: ${detail}\n${spawnHint(input.program)}\n`)
      await handle.close()
      throw error instanceof Error ? error : new Error(detail)
    }
    // A CLI must be able to exit while jobs run; the disk log keeps them readable.
    child.unref()

    const record: JobRecord = {
      projectId,
      name,
      pid: child.pid,
      child,
      logAbsPath,
      logRelPath,
      handle,
      queue: Promise.resolve(),
      totalBytes: 0,
      logCapped: false,
      exited: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      timeoutTimer: null,
      startedAt: Date.now(),
    }
    const enqueue = (write: () => Promise<unknown>): void => {
      record.queue = record.queue.then(write, write).then(() => undefined)
    }
    enqueue(() => handle.write(`${header}\n`))
    const append = (chunk: Buffer) => {
      if (record.logCapped) return
      record.totalBytes += chunk.length
      const room = MAX_LOG_FILE_BYTES - record.totalBytes + chunk.length
      const slice = room <= 0 ? null : chunk.subarray(0, Math.min(chunk.length, room))
      if (slice === null || chunk.length > room) record.logCapped = true
      if (slice && slice.length > 0) {
        enqueue(async () => {
          try {
            await record.handle?.write(slice)
          } catch {
            // Best effort: the log keeps whatever was captured.
          }
        })
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append(chunk))
    child.stderr.on('data', (chunk: Buffer) => append(chunk))
    let spawnError: Error | null = null
    const settle = async (exitCode: number | null, signal: string | null) => {
      if (record.exited) return
      record.exited = true
      record.exitCode = exitCode
      record.signal = signal
      record.endedAt = Date.now()
      if (record.timeoutTimer) {
        clearTimeout(record.timeoutTimer)
        record.timeoutTimer = null
      }
      // A spawn failure (e.g. ENOENT for an unresolvable program) otherwise
      // settles as a bare negative exit with an empty log. Keep the error text
      // plus the remediation hint in the log so polling surfaces the cause.
      const spawnReport = spawnError
        ? `spawn error: ${spawnError.message}\n${spawnHint(input.program)}\n`
        : (typeof exitCode === 'number' && exitCode < 0 ? `${spawnHint(input.program)}\n` : '')
      const footer = `\n--- exit: code=${String(exitCode)} signal=${String(signal)} timedOut=${String(record.timedOut)} wallTimeMs=${record.endedAt - record.startedAt} ---\n`
      try {
        await record.queue
        if (spawnReport) await record.handle?.write(spawnReport)
        await record.handle?.write(footer)
        await record.handle?.close()
      } catch {
        // Best effort: the log keeps whatever was captured.
      }
      record.handle = null
    }
    child.once('error', (error: Error) => {
      // 'close' always follows 'error' in Node; settle there for one code path.
      spawnError = error
    })
    child.once('close', (exitCode, signal) => {
      void settle(exitCode, signal)
    })
    if (input.timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        if (record.exited) return
        record.timedOut = true
        this.kill(record, false)
        setTimeout(() => this.kill(record, true), KILL_ESCALATION_MS).unref?.()
      }, input.timeoutMs)
      timer.unref?.()
      record.timeoutTimer = timer
    }
    this.jobs.set(projectId, record)
    while (this.jobs.size > MAX_JOBS) {
      const oldestExited = [...this.jobs.values()].find((job) => job.exited)
      const victim = oldestExited ?? this.jobs.values().next().value as JobRecord | undefined
      if (!victim) break
      if (victim.projectId === projectId) break
      this.jobs.delete(victim.projectId)
    }
    return {
      projectId,
      pid: child.pid,
      name,
      logPath: logRelPath,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }
  }

  private kill(record: JobRecord, force: boolean): void {
    if (record.exited) return
    // Note: win32 kills the whole process tree so packaging children cannot leak — see .agents/notes/implemented/feature/2026-09-13-tool-failure-recovery.md
    tryTreeKill(record.pid)
    try {
      record.child.kill((force || process.platform === 'win32') ? 'SIGKILL' : undefined)
    } catch {
      // Already gone; 'close' will settle the record.
    }
  }

  private require(projectId: string): JobRecord {
    const record = this.jobs.get(projectId)
    if (!record) throw new Error(`Unknown background job: ${projectId}`)
    return record
  }

  async poll(projectId: string, maxLines = 100, offsetLines = 0): Promise<JobPage> {
    const record = this.require(projectId)
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1000) {
      throw new Error('maxLines must be an integer between 1 and 1000')
    }
    if (!Number.isSafeInteger(offsetLines) || offsetLines < 0 || offsetLines > 1000) {
      throw new Error('offsetLines must be an integer between 0 and 1000')
    }
    let text = ''
    try {
      text = await readFile(record.logAbsPath, 'utf-8')
    } catch {
      throw new Error(`Background job log is unreadable: ${projectId}`)
    }
    const lines = splitLines(text)
    const page = lines.slice(offsetLines, offsetLines + maxLines)
    return {
      projectId,
      totalLines: lines.length,
      offsetLines,
      truncated: lines.length > offsetLines + page.length,
      output: page,
      exited: record.exited,
      ...(record.exited ? { exitCode: record.exitCode, signal: record.signal } : {}),
      timedOut: record.timedOut,
      logPath: record.logRelPath,
    }
  }

  async stop(projectId: string): Promise<JobStopped> {
    const record = this.require(projectId)
    if (record.exited) {
      return { projectId, stopped: false, exited: true, exitCode: record.exitCode, signal: record.signal, timedOut: record.timedOut }
    }
    this.kill(record, false)
    const deadline = Date.now() + STOP_WAIT_MS
    while (!record.exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!record.exited) this.kill(record, true)
    return { projectId, stopped: true, exited: record.exited, exitCode: record.exitCode, signal: record.signal, timedOut: record.timedOut }
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map((record) => ({
      projectId: record.projectId,
      name: record.name,
      pid: record.pid,
      running: !record.exited,
      exitCode: record.exitCode,
      timedOut: record.timedOut,
    }))
  }

  /** Best-effort teardown: kill running jobs, clear timers, close handles. */
  async dispose(): Promise<void> {
    for (const record of this.jobs.values()) {
      if (record.timeoutTimer) {
        clearTimeout(record.timeoutTimer)
        record.timeoutTimer = null
      }
      if (!record.exited) this.kill(record, true)
      try {
        await record.queue
        await record.handle?.close()
      } catch {
        // ignore
      }
      record.handle = null
    }
    this.jobs.clear()
  }
}
