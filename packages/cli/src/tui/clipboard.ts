/**
 * @file Best-effort composer clipboard (no React/Ink, unit tested).
 * @description `copy` always lands in an in-app fallback buffer (so cut/paste
 * survives terminals without clipboard integration) and additionally requests
 * a system copy on live TTYs. Local Windows sessions use Set-Clipboard because
 * embedded xterm hosts may not implement OSC52. Other terminals and SSH
 * sessions receive an OSC52 request, subject to host support. Reads never
 * touch the system clipboard — the app cannot query it — so `paste` serves
 * the fallback buffer while native terminal paste (Ctrl+V / right-click)
 * keeps arriving as plain text through stdin, exactly as before.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const OSC52_MIME = 'c'
/** OSC52 payloads above this are skipped (terminals choke on huge writes). */
export const OSC52_MAX_BYTES = 100_000

/** Raw escape bytes a terminal honors as "copy to system clipboard". */
export function osc52CopySequence(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return `\x1b]52;${OSC52_MIME};${encoded}\x07`
}

export interface ClipboardStdout {
  isTTY?: unknown
  write: (data: string) => unknown
}

export interface CopyResult {
  stored: boolean
  viaSystem: boolean
}

export interface ComposerClipboard {
  /** Store for in-app paste; mirrors to the system clipboard when possible. */
  copy: (text: string) => CopyResult
  /** Last copied text (empty when nothing was copied yet). */
  paste: () => string
  peek: () => string
}

// Note: embedded terminal paste reads the OS clipboard - see .agents/notes/implemented/feature/2026-09-11-composer-select-copy-paste.md
export function writeWindowsClipboard(text: string): boolean {
  try {
    const command = "$ErrorActionPreference = 'Stop'; $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Set-Clipboard -Value $text"
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
    ], {
      input: Buffer.from(text, 'utf8').toString('base64'),
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    })
    return true
  } catch {
    return false
  }
}

/** Create a clipboard bound to one stdout (TTY-gated system copy, memory fallback). */
export function createComposerClipboard(stdout?: ClipboardStdout | null): ComposerClipboard {
  let stored = ''
  return {
    copy: (text: string): CopyResult => {
      if (!text) return { stored: false, viaSystem: false }
      stored = text
      let viaSystem = false
      try {
        if (stdout?.isTTY === true && Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
          const localWindows = process.platform === 'win32' && stdout === process.stdout
            && !process.env['SSH_CONNECTION'] && !process.env['SSH_CLIENT'] && !process.env['SSH_TTY']
          viaSystem = localWindows && writeWindowsClipboard(text)
          if (!viaSystem) {
            stdout.write(osc52CopySequence(text))
            viaSystem = true
          }
        }
      } catch {
        viaSystem = false
      }
      return { stored: true, viaSystem }
    },
    paste: (): string => stored,
    peek: (): string => stored,
  }
}
