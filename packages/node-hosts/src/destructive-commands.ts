/**
 * @file Fail-closed guard against catastrophic deletions via `command.run`.
 * @description `command.run` spawns arbitrary programs with structured argv
 * (no shell string), so unlike pi-defender / pi-access-guard we do NOT need
 * bash-AST parsing or regex command lists for the common case: the program
 * and each operand are already structured data. Detections below are
 * structural (program basename + resolved operand paths), which avoids both
 * the regex fragility of pattern lists and opencode's last-match-wins rule
 * ordering footgun — there are no competing rules, only a deny list.
 *
 * Semantics (opencode `deny` parity): a match FAILS CLOSED regardless of the
 * session approval mode — explicit denies survive auto-run, and there is no
 * user override below this layer (pi-access-guard parity: system rules outrank
 * session rules). Scoped deletions inside the workspace (e.g. `rm -rf
 * ./dist`) are NOT denied here; they flow through the normal per-action
 * approval, and the model is steered toward `workspace.delete` (previewed,
 * audited, checkpointed) by the tool description instead.
 *
 * Shell-string carriers (`sh -c`, `powershell -Command`, `cmd /c`) cannot be
 * judged structurally, so their payload gets a best-effort catastrophic
 * substring scan — a second layer only, documented as heuristic (pi docs
 * admit the same for shell parsing). `-EncodedCommand` (opaque payload,
 * invisible to audit) is denied outright.
 */
import { homedir } from 'node:os'
import { basename, isAbsolute, parse, relative, resolve, sep } from 'node:path'

export interface DestructiveCommandInput {
  /** Raw program as passed to `command.run` (bare name or workspace-relative path). */
  program: string
  /** Already-validated argument strings. */
  args: string[]
  /** Workspace-absolute cwd the command would run in. */
  cwdAbsolute: string
  /** Workspace-absolute root for containment checks. */
  workspaceRootAbsolute: string
  homeDirectory?: string
}

const RM_FAMILY = new Set(['rm', 'rmdir', 'unlink', 'shred'])
const SHELL_CARRIERS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh', 'cmd', 'powershell', 'pwsh'])
/** Bare names only (see below): a workspace-relative `./format` script is a file, not the disk tool. */
const DISK_DESTROYERS = new Set(['dd', 'mkfs'])
const WINDOWS_DISK_DESTROYERS = new Set(['format', 'format.com', 'diskpart'])

/**
 * Catastrophic payload fragments for shell-string carriers. Best-effort
 * second layer: the structural checks above remain the primary defense.
 */
const CATASTROPHIC_PAYLOAD_FRAGMENTS = [
  'rm -rf /',
  'rm -fr /',
  'rm -rf /*',
  '--no-preserve-root',
  'mkfs',
  ' of=/dev/',
  'diskpart',
  ':(){ :|:& };:',
  'del /s c:\\',
  'del /s c:/',
  'rd /s c:\\',
  'rd /s c:/',
  'format c:',
  'format c:/',
]

function stripExecutableExtension(base: string): string {
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

function programBase(program: string): string {
  return stripExecutableExtension(basename(program.trim()).toLowerCase())
}

function isBareProgram(program: string): boolean {
  return !/[/\\]/.test(program.trim())
}

function normalizeAbsolute(value: string, platform: NodeJS.Platform): string {
  const normalized = resolve(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isFilesystemRoot(targetAbsolute: string): boolean {
  const root = parse(targetAbsolute).root
  return root.length > 0 && (targetAbsolute === root || targetAbsolute === root.slice(0, -1))
}

function isOutsideWorkspace(targetAbsolute: string, workspaceRootAbsolute: string, platform: NodeJS.Platform): boolean {
  const root = normalizeAbsolute(workspaceRootAbsolute, platform)
  const target = normalizeAbsolute(targetAbsolute, platform)
  if (target === root) return false
  const rel = relative(root, target)
  // Cross-drive Windows paths come back absolute from relative() — outside.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function resolveOperand(operand: string, cwdAbsolute: string, homeDirectory: string): string {
  if (operand === '~' || operand.startsWith('~/') || operand.startsWith('~\\')) {
    return resolve(homeDirectory, operand.slice(2))
  }
  return resolve(cwdAbsolute, operand)
}

interface RmOperands {
  flags: string[]
  operands: string[]
}

function splitRmArgs(args: string[]): RmOperands {
  const flags: string[] = []
  const operands: string[] = []
  let onlyOperands = false
  for (const arg of args) {
    if (onlyOperands) {
      operands.push(arg)
      continue
    }
    if (arg === '--') {
      onlyOperands = true
      continue
    }
    if (arg.length > 1 && arg.startsWith('-')) flags.push(arg)
    else operands.push(arg)
  }
  return { flags, operands }
}

function rmDeniesRmFlags(flags: string[]): string | null {
  for (const flag of flags) {
    const lower = flag.toLowerCase()
    if (lower === '--no-preserve-root' || lower.startsWith('--no-preserve-root=')) {
      return 'refusing --no-preserve-root'
    }
    const preserve = lower.match(/^--preserve-root=(.+)$/)
    if (preserve && ['no', 'none', 'false', '0'].includes(preserve[1].trim())) {
      return 'refusing --preserve-root=no'
    }
  }
  return null
}

function shellStringPayload(program: string, args: string[]): string | null {
  const flagIndex = args.findIndex((arg) => {
    const lower = arg.toLowerCase()
    return lower === '-c' || lower === '-command' || lower === '/c' || lower === '/k'
  })
  if (flagIndex < 0) return null
  // PowerShell -EncodedCommand is an opaque payload: invisible to audit and
  // to this scan. Deny fail-closed instead of guessing.
  const flag = args[flagIndex].toLowerCase()
  if ((flag === '-command' || flag === '-c') && args.slice(0, flagIndex).some((arg) => arg.toLowerCase() === '-encodedcommand')) {
    return 'ENCODED'
  }
  return args.slice(flagIndex + 1).join(' ')
}

function powershellDriveRootDelete(payloadLower: string): boolean {
  if (!payloadLower.includes('remove-item') || !payloadLower.includes('recurse')) return false
  return /(^|[\s'"`,;|&()])[a-z]:\\/.test(payloadLower)
    || payloadLower.includes('~')
    || payloadLower.includes('$home')
    || payloadLower.includes('${env:systemdrive}')
}

/**
 * Fail-closed catastrophic-deletion screen. Returns a human-readable deny
 * reason, or null when the invocation may proceed to normal approval.
 * Pure (no IO except `homedir()` default) so it unit tests without a workspace.
 */
export function evaluateDestructiveCommand(input: DestructiveCommandInput): string | null {
  const platform = process.platform
  const program = input.program.trim()
  if (!program) return null
  const homeDirectory = input.homeDirectory ?? homedir()
  const base = programBase(program)
  const bare = isBareProgram(program)
  const workspaceRoot = normalizeAbsolute(input.workspaceRootAbsolute, platform)
  const cwd = normalizeAbsolute(input.cwdAbsolute, platform)

  // Disk destroyers: no legitimate agent use. Bare names only — a
  // workspace-relative `./format` script is project code, not the disk tool.
  if (bare && DISK_DESTROYERS.has(base)) {
    return `command.run destructive-command guard: refusing disk-destroyer program "${base}"`
  }
  if (bare && platform === 'win32' && WINDOWS_DISK_DESTROYERS.has(base)) {
    return `command.run destructive-command guard: refusing disk-destroyer program "${base}"`
  }

  // rm-family: structural operand resolution against the workspace.
  if (RM_FAMILY.has(base)) {
    const { flags, operands } = splitRmArgs(input.args)
    const flagDeny = rmDeniesRmFlags(flags)
    if (flagDeny) return `command.run destructive-command guard: ${flagDeny}`
    for (const operand of operands) {
      const target = normalizeAbsolute(resolveOperand(operand, cwd, homeDirectory), platform)
      if (isFilesystemRoot(target)) {
        return `command.run destructive-command guard: refusing to delete filesystem root ("${operand}")`
      }
      if (target === normalizeAbsolute(homeDirectory, platform)) {
        return `command.run destructive-command guard: refusing to delete the home directory ("${operand}")`
      }
      if (target === workspaceRoot) {
        return `command.run destructive-command guard: refusing to delete the workspace root ("${operand}")`
      }
      if (isOutsideWorkspace(target, workspaceRoot, platform)) {
        return `command.run destructive-command guard: refusing to delete outside the workspace ("${operand}")`
      }
    }
    return null
  }

  // Shell-string carriers: best-effort catastrophic substring scan.
  if (SHELL_CARRIERS.has(base)) {
    const payload = shellStringPayload(program, input.args)
    if (payload === 'ENCODED') {
      return 'command.run destructive-command guard: refusing opaque -EncodedCommand payload'
    }
    if (payload !== null) {
      const lower = payload.toLowerCase()
      for (const fragment of CATASTROPHIC_PAYLOAD_FRAGMENTS) {
        if (lower.includes(fragment)) {
          return `command.run destructive-command guard: destructive shell payload matches blocked pattern "${fragment}"`
        }
      }
      if (powershellDriveRootDelete(lower)) {
        return 'command.run destructive-command guard: refusing recursive Remove-Item on a drive root or home directory'
      }
    }
    return null
  }

  return null
}
