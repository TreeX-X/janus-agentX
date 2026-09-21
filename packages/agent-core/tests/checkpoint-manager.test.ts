import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

// --- Mock infrastructure ---

const mockFiles: Record<string, string> = {}
const storedBlobs = new Map<string, Buffer>()
let storeCounter = 0
let uuidCounter = 0

vi.mock('crypto', () => {
  return {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
    createHash: vi.fn(),
  }
})

const mockTrackedFiles = ['src/index.ts', 'README.md']

vi.mock('../src/main/agent/checkpoint/git-adapter', () => {
  return {
    GitAdapter: vi.fn().mockImplementation(() => ({
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      stashPush: vi.fn().mockResolvedValue('stash@{0}'),
      stashPop: vi.fn().mockResolvedValue(undefined),
      stashDrop: vi.fn().mockResolvedValue(undefined),
      listTrackedFiles: vi.fn().mockImplementation(async () => [...mockTrackedFiles]),
      hashObject: vi.fn().mockResolvedValue('abc123'),
      diff: vi.fn().mockResolvedValue(''),
    })),
  }
})

vi.mock('../src/main/agent/checkpoint/blob-store', () => {
  return {
    BlobStore: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockImplementation(async (content: Buffer) => {
        const hash = `sha1-${++storeCounter}`
        storedBlobs.set(hash, content)
        return hash
      }),
      retrieve: vi.fn().mockImplementation(async (hash: string) => {
        return storedBlobs.get(hash) ?? null
      }),
      exists: vi.fn().mockImplementation(async (hash: string) => {
        return storedBlobs.has(hash)
      }),
      listHashes: vi.fn().mockImplementation(async () => {
        return Array.from(storedBlobs.keys())
      }),
      delete: vi.fn().mockImplementation(async (hash: string) => {
        storedBlobs.delete(hash)
      }),
      clear: vi.fn().mockImplementation(async () => {
        storedBlobs.clear()
      }),
    })),
  }
})

vi.mock('fs/promises', () => {
  return {
    readFile: vi.fn().mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0])
      const encoding = typeof args[1] === 'string' ? args[1] : undefined
      if (mockFiles[path]) {
        return encoding ? mockFiles[path] : Buffer.from(mockFiles[path])
      }
      throw new Error('ENOENT')
    }),
    writeFile: vi.fn().mockImplementation(async (path: string, data: string) => {
      mockFiles[String(path)] = typeof data === 'string' ? data : String(data)
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockImplementation(async (path: string) => {
      const p = String(path).replace(/\\/g, '/')
      if (p.startsWith('/workspace') || mockFiles[String(path)]) return
      throw new Error('ENOENT')
    }),
    stat: vi.fn().mockImplementation(async (path: string) => {
      if (String(path).replace(/\\/g, '/').endsWith('assets/big.bin')) {
        return { isDirectory: () => false, mtimeMs: 1, size: 3 * 1024 * 1024 }
      }
      return { isDirectory: () => true }
    }),
    rm: vi.fn().mockResolvedValue(undefined),
  }
})

// --- Tests ---

describe('CheckpointManager', () => {
  let manager: import('../src/main/agent/checkpoint/checkpoint-manager').CheckpointManager

  beforeEach(async () => {
    // Reset counters and file state
    Object.keys(mockFiles).forEach(key => delete mockFiles[key])
    storedBlobs.clear()
    storeCounter = 0
    uuidCounter = 0

    // captureWorkspaceHashIndex is the only path using real hashing;
    // the crypto mock leaves createHash empty, so back a deterministic one.
    const nodeCrypto = await import('crypto')
    vi.mocked(nodeCrypto.createHash).mockImplementation((() => ({
      update: (content: Buffer) => ({
        digest: () => `testhash-${content.byteLength}-${content.subarray(0, 32).toString('utf8')}`,
      }),
    })) as never)

    // Populate mockFiles with tracked file content (paths as the source code would resolve them)
    for (const root of ['/workspace', '/workspace-a', '/workspace-b']) {
      mockFiles[join(root, 'src/index.ts')] = `export const workspace = "${root}"`
      mockFiles[join(root, 'README.md')] = `# ${root}`
    }

    const { CheckpointManager } = await import('../src/main/agent/checkpoint/checkpoint-manager')
    manager = new CheckpointManager()
    await manager.initialize('/workspace')
  })

  it('initialize() creates storage dirs', async () => {
    const fs = await import('fs/promises')
    const mkdirMock = vi.mocked(fs.mkdir)
    expect(mkdirMock).toHaveBeenCalled()
    const firstCallPath = mkdirMock.mock.calls[0][0] as string
    expect(firstCallPath).toContain('checkpoints')
    expect(firstCallPath).toContain('blobs')
    expect(mkdirMock.mock.calls[0][1]).toEqual({ recursive: true })
  })

  it('createCheckpoint() returns checkpoint with correct fields', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'test prompt',
      cwd: '/workspace',
    })
    expect(checkpoint.id).toBe('uuid-1')
    expect(checkpoint.terminalId).toBe('term-1')
    expect(checkpoint.engine).toBe('claude')
    expect(checkpoint.branch).toBe('main')
    expect(checkpoint.status).toBe('ready')
    expect(checkpoint.prompt).toBe('test prompt')
    expect(checkpoint.conversationIndex).toBe(1)
    expect(checkpoint.filesSnapshot).toBeDefined()
    expect(checkpoint.schemaVersion).toBe(2)
  })

  it('createCheckpoint() increments conversationIndex within a workspace', async () => {
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'first',
      cwd: '/workspace',
    })
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'second',
      cwd: '/workspace',
    })
    await manager.createCheckpoint({
      terminalId: 'term-2',
      engine: 'codex',
      prompt: 'other terminal',
      cwd: '/workspace',
    })

    const list = await manager.listCheckpoints()
    const term1Cps = list.filter(cp => cp.terminalId === 'term-1')
    const term2Cps = list.filter(cp => cp.terminalId === 'term-2')
    expect(term1Cps.find(cp => cp.prompt === 'first')?.conversationIndex).toBe(1)
    expect(term1Cps.find(cp => cp.prompt === 'second')?.conversationIndex).toBe(2)
    expect(term2Cps[0].conversationIndex).toBe(3)
  })

  it('listCheckpoints() isolates checkpoints by workspace cwd', async () => {
    await manager.createCheckpoint({
      terminalId: 'term-a',
      engine: 'claude',
      prompt: 'workspace A',
      cwd: '/workspace-a',
    })
    await manager.createCheckpoint({
      terminalId: 'term-b',
      engine: 'codex',
      prompt: 'workspace B',
      cwd: '/workspace-b',
    })

    const workspaceA = await manager.listCheckpoints({ cwd: '/workspace-a' })
    const workspaceB = await manager.listCheckpoints({ cwd: '/workspace-b' })

    expect(workspaceA.map(cp => cp.prompt)).toEqual(['workspace A'])
    expect(workspaceB.map(cp => cp.prompt)).toEqual(['workspace B'])
    expect(workspaceA[0].conversationIndex).toBe(1)
    expect(workspaceB[0].conversationIndex).toBe(1)
  })

  it('createCheckpoint() snapshots tracked files', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'snapshot test',
      cwd: '/workspace',
    })
    expect(Object.keys(checkpoint.filesSnapshot)).toContain('src/index.ts')
    expect(Object.keys(checkpoint.filesSnapshot)).toContain('README.md')
  })

  it('finalizeCheckpoint() keeps ready checkpoints ready', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'finalize test',
      cwd: '/workspace',
    })
    expect(checkpoint.status).toBe('ready')
    await manager.finalizeCheckpoint(checkpoint.id, '/workspace')
    const list = await manager.listCheckpoints()
    const finalized = list.find(cp => cp.id === checkpoint.id)
    expect(finalized?.status).toBe('ready')
  })

  it('finalizeCheckpoint() throws for unknown id', async () => {
    await expect(manager.finalizeCheckpoint('nonexistent-id', '/workspace')).rejects.toThrow(
      'Checkpoint not found: nonexistent-id',
    )
  })

  it('restoreCheckpoint() returns empty conflicts when files unchanged', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'restore test',
      cwd: '/workspace',
    })
    const result = await manager.restoreCheckpoint(checkpoint.id, '/workspace')
    expect(result.conflicts).toEqual([])
  })

  it('restoreCheckpoint() throws for unknown id', async () => {
    await expect(manager.restoreCheckpoint('nonexistent-id', '/workspace')).rejects.toThrow(
      'Checkpoint not found: nonexistent-id',
    )
  })

  it('listCheckpoints() returns sorted by createdAt desc', async () => {
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'first',
      cwd: '/workspace',
    })
    // Small delay to ensure different createdAt
    await new Promise(r => setTimeout(r, 10))
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'second',
      cwd: '/workspace',
    })

    const list = await manager.listCheckpoints()
    expect(list.length).toBe(2)
    // Most recent first
    expect(list[0].createdAt >= list[1].createdAt).toBe(true)
  })

  it.each([
    [{ terminalId: 'term-1' }, 'terminalId', 'term-1'],
    [{ engine: 'codex' }, 'engine', 'codex'],
  ] as const)('listCheckpoints() filters by %s', async (filter, field, expected) => {
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'first',
      cwd: '/workspace',
    })
    await manager.createCheckpoint({
      terminalId: 'term-2',
      engine: 'codex',
      prompt: 'second',
      cwd: '/workspace',
    })

    const filtered = await manager.listCheckpoints(filter)
    expect(filtered.length).toBe(1)
    expect((filtered[0] as Record<string, unknown>)[field as string]).toBe(expected)
  })

  it('deleteCheckpoint() removes from internal map and unreferenced blobs', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'delete me',
      cwd: '/workspace',
    })
    const before = await manager.listCheckpoints()
    expect(before.length).toBe(1)
    expect(storedBlobs.size).toBeGreaterThan(0)

    await manager.deleteCheckpoint(checkpoint.id)

    const after = await manager.listCheckpoints()
    expect(after.length).toBe(0)
    expect(storedBlobs.size).toBe(0)
  })

  it('clearAll() clears checkpoint blobs', async () => {
    await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'clear blobs',
      cwd: '/workspace',
    })
    expect(storedBlobs.size).toBeGreaterThan(0)

    await manager.clearAll()

    expect(storedBlobs.size).toBe(0)
  })

  it('deleteCheckpoint() is a no-op for unknown id', async () => {
    // Should not throw
    await manager.deleteCheckpoint('nonexistent-id')
    const list = await manager.listCheckpoints()
    expect(list.length).toBe(0)
  })

  it('getDiff() returns diff string for known file', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'diff test',
      cwd: '/workspace',
    })

    mockFiles[join('/workspace', 'src/index.ts')] = 'export const hello = "janus"'

    const diff = await manager.getDiff(checkpoint.id, 'src/index.ts', '/workspace')
    expect(diff).toContain('--- a/src/index.ts')
    expect(diff).toContain('janus')
  })

  it.each([
    ['unknown file', () => manager.createCheckpoint({ terminalId: 'term-1', engine: 'claude', prompt: 'diff test', cwd: '/workspace' }).then(cp => manager.getDiff(cp.id, 'nonexistent.ts'))],
    ['unknown checkpoint', () => Promise.resolve(manager.getDiff('nonexistent-id', 'src/index.ts'))],
  ] as const)('getDiff() returns empty string for %s', async (_label, run) => {
    const diff = await run()
    expect(diff).toBe('')
  })

  it('createCheckpoint() persists session binding fields', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1',
      engine: 'claude',
      prompt: 'session bound',
      cwd: '/workspace',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      kind: 'done',
      parentId: 'uuid-0',
    })
    expect(checkpoint.sessionId).toBe('sess-1')
    expect(checkpoint.turnId).toBe('turn-1')
    expect(checkpoint.kind).toBe('done')
    expect(checkpoint.parentId).toBe('uuid-0')
    const listed = await manager.listCheckpoints({ sessionId: 'sess-1' })
    expect(listed.map(cp => cp.id)).toEqual([checkpoint.id])
  })

  it('restoreCheckpoint() with session scope preserves other sessions', async () => {
    const a1 = await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'a1', cwd: '/workspace', sessionId: 'sess-a',
    })
    await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'a2', cwd: '/workspace', sessionId: 'sess-a',
    })
    const b1 = await manager.createCheckpoint({
      terminalId: 'term-2', engine: 'codex', prompt: 'b1', cwd: '/workspace', sessionId: 'sess-b',
    })
    await manager.restoreCheckpoint(a1.id, '/workspace', { sessionId: 'sess-a' })
    const remaining = await manager.listCheckpoints()
    // The restore target itself stays; the same-session later checkpoint is
    // pruned while the other session is untouched.
    expect(remaining.map(cp => cp.id).sort()).toEqual([a1.id, b1.id].sort())
  })

  it('restoreCheckpoint() without scope prunes the same terminal only', async () => {
    const a1 = await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'a1', cwd: '/workspace',
    })
    await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'a2', cwd: '/workspace',
    })
    const b1 = await manager.createCheckpoint({
      terminalId: 'term-2', engine: 'codex', prompt: 'b1', cwd: '/workspace',
    })
    await manager.restoreCheckpoint(a1.id, '/workspace')
    const remaining = await manager.listCheckpoints()
    expect(remaining.map(cp => cp.id).sort()).toEqual([a1.id, b1.id].sort())
  })

  it('oversized files record without blobs and survive restore untouched', async () => {
    mockTrackedFiles.push('assets/big.bin')
    mockFiles[join('/workspace', 'assets/big.bin')] = 'x'.repeat(3 * 1024 * 1024)
    try {
      const checkpoint = await manager.createCheckpoint({
        terminalId: 'term-1', engine: 'claude', prompt: 'big', cwd: '/workspace',
      })
      expect(checkpoint.filesSnapshot['assets/big.bin']?.hash).toBe('')
      // No 3MB blob entered the store.
      for (const content of storedBlobs.values()) {
        expect(content.byteLength).toBeLessThan(2 * 1024 * 1024)
      }
      expect(await manager.getDiff(checkpoint.id, 'assets/big.bin', '/workspace')).toBe('')

      mockFiles[join('/workspace', 'assets/big.bin')] = 'y'.repeat(3 * 1024 * 1024 + 1)
      await manager.restoreCheckpoint(checkpoint.id, '/workspace')
      // Oversized content is left alone, never deleted, never rewritten.
      expect(mockFiles[join('/workspace', 'assets/big.bin')]).toBe('y'.repeat(3 * 1024 * 1024 + 1))

      const records = await manager.getChangedFileRecords(checkpoint.id, '/workspace')
      const big = records.find(r => r.path === 'assets/big.bin')
      expect(big?.status).toBe('oversized')
      expect(big?.additions).toBeNull()
    } finally {
      mockTrackedFiles.length = 0
      mockTrackedFiles.push('src/index.ts', 'README.md')
      delete mockFiles[join('/workspace', 'assets/big.bin')]
    }
  })

  it('binary files yield empty diffs and binary records', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'bin', cwd: '/workspace',
    })
    mockFiles[join('/workspace', 'src/index.ts')] = 'AB\x00CD'
    expect(await manager.getDiff(checkpoint.id, 'src/index.ts', '/workspace')).toBe('')
    const records = await manager.getChangedFileRecords(checkpoint.id, '/workspace')
    const rec = records.find(r => r.path === 'src/index.ts')
    expect(rec?.status).toBe('binary')
    expect(rec?.additions).toBeNull()
  })

  it('getChangedFileRecords() reports modified files with line counts', async () => {
    const checkpoint = await manager.createCheckpoint({
      terminalId: 'term-1', engine: 'claude', prompt: 'rec', cwd: '/workspace',
    })
    mockFiles[join('/workspace', 'src/index.ts')] = 'line1\nline2\nline3\n'
    const records = await manager.getChangedFileRecords(checkpoint.id, '/workspace')
    const rec = records.find(r => r.path === 'src/index.ts')
    expect(rec?.status).toBe('modified')
    // getDiff renders (current, snapshot): 1 added snapshot line, 4 removed current lines.
    expect(rec?.additions).toBe(1)
    expect(rec?.deletions).toBe(4)
  })
})
