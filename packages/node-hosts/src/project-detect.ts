/**
 * @file Node host implementation of `project.detect`.
 * @description The chat layer advertises `project_detect` to the model, but the
 * implementation is host-owned (agent-core only declares the port): without
 * this module the janus CLI offers a tool that can only fail at execution.
 * Walks one workspace directory (bounded depth/directory budget, skips
 * build output and sensitive paths) and reports project markers —
 * package.json scripts, python/rust/go/java/php/dotnet/cmake/docker files —
 * so the model can answer "what is this project, how do I run it".
 * Read-only (`inspect` risk, no approval), dependency-free.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  isSensitivePath,
  resolveWorkspaceTarget,
  type RegisteredTool,
  type ToolRegistry,
} from '@janus-agent/agent-core'

const registeredRegistries = new WeakSet<ToolRegistry>()

const MAX_DEPTH = 4
const MAX_DIRECTORIES = 600
const MAX_PROJECTS = 50
const MAX_MANIFEST_BYTES = 64 * 1024

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', 'coverage', '.tox', '.mypy_cache', '.pytest_cache', '.idea', '.vscode',
])

export interface DetectedProject {
  /** Workspace-relative posix path ('.' for the scan root). */
  path: string
  kinds: string[]
  name?: string
  scripts?: string[]
}

interface Marker {
  kinds: string[]
  parse?: (content: string) => { name?: string; scripts?: string[] }
}

function parsePackageJson(content: string): { name?: string; scripts?: string[] } {
  const parsed = JSON.parse(content) as { name?: unknown; scripts?: unknown }
  const out: { name?: string; scripts?: string[] } = {}
  if (typeof parsed.name === 'string' && parsed.name) out.name = parsed.name.slice(0, 120)
  if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
    out.scripts = Object.keys(parsed.scripts as Record<string, unknown>).slice(0, 20)
  }
  return out
}

function parseTomlName(content: string): { name?: string } {
  const match = /^name\s*=\s*["']([^"']{1,120})["']/m.exec(content)
  return match?.[1] ? { name: match[1] } : {}
}

const FILE_MARKERS: Array<{ file: (name: string) => boolean; kinds: string[]; parse?: Marker['parse'] }> = [
  { file: (name) => name === 'package.json', kinds: ['node'], parse: parsePackageJson },
  { file: (name) => name === 'pyproject.toml', kinds: ['python'], parse: parseTomlName },
  { file: (name) => name === 'setup.py' || name === 'setup.cfg' || name === 'requirements.txt', kinds: ['python'] },
  { file: (name) => name === 'Cargo.toml', kinds: ['rust'], parse: parseTomlName },
  { file: (name) => name === 'go.mod', kinds: ['go'] },
  { file: (name) => name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts', kinds: ['java'] },
  { file: (name) => name === 'composer.json', kinds: ['php'] },
  { file: (name) => name.endsWith('.csproj') || name.endsWith('.sln'), kinds: ['dotnet'] },
  { file: (name) => name === 'CMakeLists.txt', kinds: ['cmake'] },
  { file: (name) => name === 'Makefile' || name === 'makefile' || name === 'GNUmakefile', kinds: ['make'] },
  { file: (name) => name === 'Dockerfile' || name === 'docker-compose.yml' || name === 'docker-compose.yaml', kinds: ['docker'] },
]

function readBounded(absolute: string): string | null {
  try {
    if (statSync(absolute).size > MAX_MANIFEST_BYTES) return null
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

function inspectDirectory(absolute: string): DetectedProject | null {
  let entries
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch {
    return null
  }
  const kinds = new Set<string>()
  let name: string | undefined
  let scripts: string[] | undefined
  let isGitRepo = false
  for (const entry of entries) {
    if (!entry.isFile()) {
      if (entry.isDirectory() && entry.name === '.git') isGitRepo = true
      continue
    }
    for (const marker of FILE_MARKERS) {
      if (!marker.file(entry.name)) continue
      for (const kind of marker.kinds) kinds.add(kind)
      if (marker.parse && name === undefined && scripts === undefined) {
        const content = readBounded(join(absolute, entry.name))
        if (content !== null) {
          try {
            const parsed = marker.parse(content)
            name ??= parsed.name
            scripts ??= parsed.scripts
          } catch {
            // Malformed manifest: keep the kind, drop the details.
          }
        }
      }
    }
  }
  if (kinds.size === 0) return null
  const project: DetectedProject = { path: '', kinds: [...kinds].sort() }
  if (name) project.name = name
  if (scripts?.length) project.scripts = scripts
  if (isGitRepo) project.kinds.push('git')
  return project
}

export function detectProjects(root: string, maxDepth: number, maxDirectories: number): DetectedProject[] {
  const projects: DetectedProject[] = []
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && projects.length < MAX_PROJECTS && visited < maxDirectories) {
    const current = queue.shift() as { absolute: string; relative: string; depth: number }
    visited += 1
    const found = inspectDirectory(current.absolute)
    if (found) {
      found.path = current.relative ? current.relative.replace(/\\/g, '/') : '.'
      projects.push(found)
    }
    if (current.depth >= maxDepth) continue
    let entries
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const relativeChild = current.relative ? `${current.relative}/${entry.name}` : entry.name
      if (isSensitivePath(relativeChild.replace(/\\/g, '/'))) continue
      queue.push({ absolute: join(current.absolute, entry.name), relative: relativeChild, depth: current.depth + 1 })
    }
  }
  return projects
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, parsed))
}

export const projectDetectTool: RegisteredTool = {
  name: 'project.detect',
  description: 'Detect project types, scripts and candidate project directories in the active workspace.',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'number' },
      maxDirectories: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('project.detect workspaceId must match the active workspace resource')
    }
    const requestedPath = input.path ?? ''
    if (typeof requestedPath !== 'string') throw new Error('project.detect path must be a string')
    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (target.kind !== 'directory') throw new Error('project.detect path must be a directory')
    // Fail closed outside the workspace (resolveWorkspaceTarget already jails,
    // this is the belt-and-suspenders check before a recursive walk).
    const root = resolve(context.workspaceRoot, target.relativePath || '.')
    const workspaceRoot = resolve(context.workspaceRoot)
    if (root !== workspaceRoot && !root.startsWith(workspaceRoot + sep)) {
      throw new Error('project.detect path is outside the workspace')
    }
    const projects = detectProjects(
      root,
      clampInt(input.depth, 3, 0, MAX_DEPTH),
      clampInt(input.maxDirectories, 300, 1, MAX_DIRECTORIES),
    )
    return { workspaceId: context.workspaceId, path: target.relativePath, projects }
  },
}

export function registerProjectDetectTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  if (!registry.get(projectDetectTool.name)) registry.register(projectDetectTool)
  registeredRegistries.add(registry)
}
