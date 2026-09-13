/**
 * @file Single source of truth for the Windows shell shim.
 * @description Package-manager shims (`npm`/`yarn`/`pnpm`/`bun`) and
 * `.cmd`/`.bat` files resolve through `cmd.exe`. Bare `spawn` without
 * `shell:true` misses them with `ENOENT` (surfaced as a negative exit such as
 * `-4058` on Windows). Both the sync `command.run` path and the background
 * `JobManager` path consult this helper so the two never drift apart again.
 */

import { extname } from 'node:path'

export type NodeCommandExecutionMode = 'direct' | 'windows-shell-shim'

export const WINDOWS_SHELL_COMMANDS = new Set(['npm', 'yarn', 'pnpm', 'bun'])
export const WINDOWS_SHELL_META = /[&|<>^\r\n]/

/** Windows package-manager shims and .cmd/.bat files need cmd.exe compatibility. */
export function commandExecutionMode(
  program: string,
  platform: NodeJS.Platform = process.platform,
): NodeCommandExecutionMode {
  if (platform !== 'win32') return 'direct'
  return WINDOWS_SHELL_COMMANDS.has(program.toLowerCase())
    || ['.bat', '.cmd'].includes(extname(program).toLowerCase())
    ? 'windows-shell-shim'
    : 'direct'
}
