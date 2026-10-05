import { open, opendir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

// Note: detect imported configuration without certifying runtime behavior — see .agents/notes/2026-10-05-workflowx-detection--844d119b.md
export type WorkflowXStatus = 'detected' | 'missing' | 'uncertain'
export interface WorkflowXSource {
  format: 'claude' | 'codex'
  scope: 'global' | 'workspace'
  path: string
  status: 'detected' | 'uncertain'
  reason: 'entry' | 'skill' | 'plugin' | 'reference' | 'unreadable' | 'cache' | 'disabled'
}
export interface WorkflowXDetection {
  status: WorkflowXStatus
  sources: WorkflowXSource[]
  checkedAt: number
}
export interface WorkflowXDetectionOptions {
  workspacePath?: string
  homeDir?: string
  claudeDir?: string
  codexDir?: string
}

const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 100
const isWorkflowX = (name: string): boolean => /^workflowx(?:@|$)/i.test(name)
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only actual instruction text counts; fenced examples cannot supply a marker. */
function instructionText(text: string): string {
  let fence: string | undefined
  return text.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (match) {
      if (!fence) fence = match[1]
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined
      return false
    }
    return !fence && !/^(?: {4}|\t|\s*>)/.test(line)
  }).join('\n')
}

/** Bounded, read-only checks. Hosts own refresh scheduling and presentation. */
export async function detectWorkflowX(options: WorkflowXDetectionOptions = {}): Promise<WorkflowXDetection> {
  const home = options.homeDir ?? homedir()
  const roots = [
    { format: 'claude' as const, scope: 'global' as const, path: options.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')) },
    { format: 'codex' as const, scope: 'global' as const, path: options.codexDir ?? (process.env.CODEX_HOME || join(home, '.codex')) },
  ]
  const sources: WorkflowXSource[] = []
  let readsRemaining = 256
  type Root = { format: 'claude' | 'codex'; scope: 'global' | 'workspace'; path: string }
  const add = (root: Root, path: string, reason: WorkflowXSource['reason'], detected = false) => {
    if (!sources.some(s => s.path === path && s.reason === reason && s.format === root.format)) {
      sources.push({ format: root.format, scope: root.scope, path, status: detected ? 'detected' : 'uncertain', reason })
    }
  }
  async function read(root: Root, path: string): Promise<string | undefined> {
    if (--readsRemaining < 0) { add(root, root.path, 'unreadable'); return }
    try {
      const file = await open(path, 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > MAX_BYTES) { add(root, path, 'unreadable'); return }
        const buffer = Buffer.alloc(MAX_BYTES + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > MAX_BYTES) { add(root, path, 'unreadable'); return }
        return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
      } finally { await file.close() }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) add(root, path, 'unreadable')
    }
  }
  async function json(root: Root, path: string): Promise<Record<string, unknown>> {
    const raw = await read(root, path)
    if (!raw) return {}
    try { return record(JSON.parse(raw)) } catch { add(root, path, 'unreadable'); return {} }
  }
  async function directories(root: Root, path: string): Promise<string[]> {
    const result: string[] = []
    if (--readsRemaining < 0) { add(root, root.path, 'unreadable'); return result }
    try {
      const dir = await opendir(path)
      let count = 0
      for await (const entry of dir) {
        if (++count > MAX_ENTRIES) { add(root, path, 'unreadable'); break }
        if (entry.isDirectory() || entry.isSymbolicLink()) result.push(entry.name)
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) add(root, path, 'unreadable')
    }
    return result.sort()
  }
  async function entry(root: Root, path: string): Promise<boolean> {
    const raw = await read(root, path)
    if (raw === undefined) return false
    const text = instructionText(raw)
    if (/^<!-- wfx-managed: workflowx-entry -->\s*$[\s\S]*^<!-- wfx-managed-end -->\s*$/m.test(text)) add(root, path, 'entry', true)
    else if (/\bworkflowx\b|\borchestrateX\b/i.test(text)) add(root, path, 'reference')
    return raw.trim().length > 0
  }
  async function skill(root: Root): Promise<void> {
    const path = join(root.path, 'skills', 'orchestrateX', 'SKILL.md')
    const raw = await read(root, path)
    if (raw === undefined) return
    // A deployed, discoverable routing skill is a stable identity, not a package inventory.
    const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    if (header && /^name:\s*["']?orchestrateX["']?\s*$/m.test(header)) add(root, path, 'skill', true)
    else add(root, path, 'reference')
  }
  async function manifest(root: Root, base: string, active: boolean, disabled = false): Promise<boolean> {
    const path = join(base, `.${root.format}-plugin`, 'plugin.json')
    const data = await json(root, path)
    if (typeof data.name !== 'string' || !isWorkflowX(data.name)) return false
    const repo = typeof data.repository === 'string' ? data.repository : record(data.repository).url
    const official = typeof repo === 'string' && /^https:\/\/github\.com\/TreeX-X\/workflowx(?:\.git)?\/?$/i.test(repo)
    add(root, path, disabled ? 'disabled' : active && official ? 'plugin' : 'cache', active && official && !disabled)
    return true
  }

  for (const globalRoot of roots) {
    const localRoot: Root | undefined = options.workspacePath
      ? { format: globalRoot.format, scope: 'workspace', path: join(options.workspacePath, `.${globalRoot.format}`) } : undefined
    for (const root of [globalRoot, ...(localRoot ? [localRoot] : [])]) {
      if (root.format === 'claude') {
        await entry(root, join(root.path, 'CLAUDE.md'))
        await entry(root, join(root.path, 'CLAUDE.local.md'))
        if (root.scope === 'workspace') {
          await entry(root, join(options.workspacePath!, 'CLAUDE.md'))
          await entry(root, join(options.workspacePath!, 'CLAUDE.local.md'))
        }
      } else {
        const base = root.scope === 'workspace' ? options.workspacePath! : root.path
        if (!await entry(root, join(base, 'AGENTS.override.md'))) await entry(root, join(base, 'AGENTS.md'))
      }
      await skill(root)
    }

    const enabled: Record<string, unknown> = {}
    const enabledSources = new Map<string, { root: Root; path: string }>()
    for (const root of [globalRoot, ...(localRoot ? [localRoot] : [])]) {
      if (root.format === 'claude') {
        for (const file of ['settings.json', 'settings.local.json']) {
          const path = join(root.path, file)
          for (const [key, value] of Object.entries(record((await json(root, path)).enabledPlugins))) {
            enabled[key] = value
            enabledSources.set(key, { root, path })
          }
        }
      } else {
        const path = join(root.path, 'config.toml')
        const raw = await read(root, path)
        if (raw) {
          try {
            for (const [key, value] of Object.entries(record(parseToml(raw).plugins))) {
              enabled[key] = record(value).enabled
              enabledSources.set(key, { root, path })
            }
          } catch { add(root, path, 'unreadable') }
        }
      }
    }
    const registered = new Set<string>()
    const registryPath = join(globalRoot.path, 'plugins', 'installed_plugins.json')
    const registry = record((await json(globalRoot, registryPath)).plugins)
    for (const [key, value] of Object.entries(registry)) {
      if (!isWorkflowX(key)) continue
      for (const item of Array.isArray(value) ? value : [value]) {
        const installation = record(item)
        const project = installation.scope === 'project' || installation.scope === 'local'
        if (project && (typeof installation.projectPath !== 'string' || !options.workspacePath
          || resolve(installation.projectPath) !== resolve(options.workspacePath))) continue
        const root = project && localRoot ? localRoot : globalRoot
        if (typeof installation.installPath === 'string') {
          registered.add(key)
          if (!await manifest(root, installation.installPath, true, enabled[key] === false)) add(root, registryPath, 'reference')
        } else add(root, registryPath, 'reference')
      }
    }
    // Only the WorkflowX package within the known cache layout, never arbitrary repo recursion.
    const cache = join(globalRoot.path, 'plugins', 'cache')
    for (const marketplace of await directories(globalRoot, cache)) {
      const base = join(cache, marketplace, 'workflowx')
      const key = Object.keys(enabled).find(key => key.toLowerCase() === `workflowx@${marketplace}`.toLowerCase())
      for (const version of await directories(globalRoot, base)) {
        await manifest(globalRoot, join(base, version), Boolean(key && (enabled[key] === true || registered.has(key))), Boolean(key && enabled[key] === false))
      }
    }
    for (const [key, active] of Object.entries(enabled)) {
      if (!isWorkflowX(key) || registered.has(key)) continue
      if (!sources.some(s => s.format === globalRoot.format && s.reason === 'plugin')) {
        const source = enabledSources.get(key)!
        add(source.root, source.path, active === false ? 'disabled' : 'reference')
      }
    }
  }
  return {
    status: sources.some(s => s.status === 'detected') ? 'detected' : sources.length ? 'uncertain' : 'missing',
    sources,
    checkedAt: Date.now(),
  }
}
