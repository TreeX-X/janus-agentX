import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { searchWorkspace } from '../src/main/agent/runtime/tools/workspace-search'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'janusx-search-passthrough-'))
  temporaryDirectories.push(directory)
  return directory
}

function rgMatch(path: string, line: number, text: string): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [],
    },
  })
}

function rgEnd(path: string): string {
  return JSON.stringify({ type: 'end', data: { path: { text: path } } })
}

/** Feed canned rg --json lines, then close(0) like a successful scan. */
function mockRgOnce(lines: string[]) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (_encoding: string) => void }
  stdout.setEncoding = () => undefined
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (_encoding: string) => void }
  stderr.setEncoding = () => undefined
  const child = new EventEmitter() as EventEmitter & { stdout: unknown; stderr: unknown; kill: () => void }
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn()
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      for (const line of lines) stdout.emit('data', `${line}\n`)
      child.emit('close', 0)
    })
    return child as never
  })
  return child
}

function baseOptions(root: string, extra: Record<string, unknown> = {}) {
  return {
    root,
    path: '',
    query: 'needle',
    mode: 'content' as const,
    regex: false,
    caseSensitive: false,
    maxResults: 30,
    signal: new AbortController().signal,
    ...extra,
  }
}

describe('workspace.search single-passthrough (mocked rg)', () => {
  beforeEach(() => { vi.mocked(spawn).mockClear() })
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })
  it('returns flat hits with per-file scan counts and no extra reads', async () => {
    const root = await temporaryDirectory()
    mockRgOnce([
      rgMatch('./src/a.ts', 3, 'has needle here'),
      rgEnd('./src/a.ts'),
      rgMatch('./b.ts', 1, 'needle top'),
      rgEnd('./b.ts'),
    ])

    const result = await searchWorkspace(baseOptions(root))

    expect(result.backend).toBe('ripgrep')
    expect(result.truncated).toBe(false)
    expect(result.scannedFiles).toBe(2)
    expect(result.matches).toEqual([
      { path: 'src/a.ts', line: 3, text: 'has needle here' },
      { path: 'b.ts', line: 1, text: 'needle top' },
    ])
    // One process for the whole scope, not one per batch.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1)
  })

  it('filters excluded paths result-side while still counting scanned files', async () => {
    const root = await temporaryDirectory()
    mockRgOnce([
      rgMatch('./node_modules/dep.js', 1, 'needle'),
      rgEnd('./node_modules/dep.js'),
      rgMatch('./.env', 1, 'NEEDLE=x'),
      rgEnd('./.env'),
      rgMatch('./src/ok.ts', 2, 'needle ok'),
      rgEnd('./src/ok.ts'),
    ])

    const result = await searchWorkspace(baseOptions(root))

    expect(result.scannedFiles).toBe(3)
    expect(result.matches).toEqual([{ path: 'src/ok.ts', line: 2, text: 'needle ok' }])
  })

  it('applies the user glob result-side so ignores stay effective', async () => {
    const root = await temporaryDirectory()
    mockRgOnce([
      rgMatch('./a.ts', 1, 'needle'),
      rgEnd('./a.ts'),
      rgMatch('./b.md', 1, 'needle'),
      rgEnd('./b.md'),
    ])

    const result = await searchWorkspace(baseOptions(root, { glob: '**/*.ts' }))

    expect(result.matches).toEqual([{ path: 'a.ts', line: 1, text: 'needle' }])
    // The glob is not forwarded as a positive rg glob (which would override
    // ignore files); assert no --glob=<user glob> reached the process.
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[]
    expect(args.filter((arg) => arg === '**/*.ts')).toHaveLength(0)
  })

  it('stops the producer at maxResults and reports truncation', async () => {
    const root = await temporaryDirectory()
    const child = mockRgOnce([
      rgMatch('./a.ts', 1, 'needle one'),
      rgMatch('./a.ts', 2, 'needle two'),
      rgMatch('./a.ts', 3, 'needle three'),
      rgEnd('./a.ts'),
    ])

    const result = await searchWorkspace(baseOptions(root, { maxResults: 2 }))

    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(child.kill).toHaveBeenCalled()
  })

  it('groups hunks with the file hash only when withContext is set', async () => {
    const root = await temporaryDirectory()
    const source = 'first line\nsecond has needle\nthird line\n'
    await writeFile(join(root, 'code.ts'), source, 'utf-8')
    mockRgOnce([
      rgMatch('./code.ts', 2, 'second has needle'),
      rgEnd('./code.ts'),
    ])

    const grouped = await searchWorkspace(baseOptions(root, { withContext: true }))

    expect(grouped.matches).toMatchObject([{
      path: 'code.ts',
      matchCount: 1,
      hunks: [{
        start: 1,
        end: 3,
        lines: [
          { line: 1, text: 'first line', hit: false },
          { line: 2, text: 'second has needle', hit: true },
          { line: 3, text: 'third line', hit: false },
        ],
      }],
    }])
    expect(typeof (grouped.matches[0] as { sha256?: unknown }).sha256).toBe('string')
  })
})
