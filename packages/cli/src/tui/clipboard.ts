/**
 * @file Best-effort composer clipboard (no React/Ink, unit tested).
 * @description `copy` always lands in an in-app fallback buffer (so cut/paste
 * survives terminals without clipboard integration) and additionally emits an
 * OSC52 `CLIPBOARD` write on live TTYs, which modern terminals (Windows
 * Terminal, VS Code, most xterm-likes, SSH remotes) honor as a system
 * clipboard copy with zero dependencies and zero subprocesses. Reads never
 * touch the system clipboard — the app cannot query it — so `paste` serves
 * the fallback buffer while native terminal paste (Ctrl+V / right-click)
 * keeps arriving as plain text through stdin, exactly as before.
 */
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

/** Create a clipboard bound to one stdout (TTY-gated OSC52, memory fallback). */
export function createComposerClipboard(stdout?: ClipboardStdout | null): ComposerClipboard {
  let stored = ''
  return {
    copy: (text: string): CopyResult => {
      if (!text) return { stored: false, viaSystem: false }
      stored = text
      let viaSystem = false
      try {
        if (stdout?.isTTY === true && Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
          stdout.write(osc52CopySequence(text))
          viaSystem = true
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
