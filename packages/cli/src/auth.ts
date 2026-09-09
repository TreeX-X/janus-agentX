/**
 * @file Per-provider API key store for the janus CLI (opencode `auth.json` equivalent).
 * @description Keys live in `~/.janus/auth.json`, never in the provider catalog
 * (`~/.janus/config.json` stays safe to share). File holds ONLY secrets:
 * `{ version: 1, keys: { <providerId>: <key> } }`. Key material is never
 * logged or echoed: status lines show the source (`auth.json`), never values.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface AuthCatalog {
  version: 1
  keys: Record<string, string>
}

export function emptyAuth(): AuthCatalog {
  return { version: 1, keys: {} }
}

/** Parses untrusted JSON; keeps only non-empty string keys under string ids. */
export function parseAuth(value: unknown): AuthCatalog {
  const record = value as Record<string, unknown> | null
  const keys: Record<string, string> = {}
  const raw = record?.keys as Record<string, unknown> | undefined
  if (raw && typeof raw === 'object') {
    for (const [id, key] of Object.entries(raw)) {
      if (id.trim() && typeof key === 'string' && key) keys[id] = key
    }
  }
  return { version: 1, keys }
}

export function serializeAuth(auth: AuthCatalog): string {
  return JSON.stringify(auth, null, 2)
}

export function defaultAuthPath(): string {
  return join(homedir(), '.janus', 'auth.json')
}

export function loadAuthFile(
  path: string,
  onError?: (error: unknown, operation: 'load' | 'save') => void,
): AuthCatalog {
  try {
    if (!existsSync(path)) return emptyAuth()
    return parseAuth(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    onError?.(error, 'load')
    return emptyAuth()
  }
}

export function saveAuthFile(
  path: string,
  auth: AuthCatalog,
  onError?: (error: unknown, operation: 'load' | 'save') => void,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${serializeAuth(auth)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      // Best effort: mode only applies at creation on some platforms.
      chmodSync(path, 0o600)
    } catch {
      // Non-POSIX filesystems (Windows ACLs) ignore chmod; the file content
      // is still correct, so teardown must not fail.
    }
  } catch (error) {
    onError?.(error, 'save')
  }
}
