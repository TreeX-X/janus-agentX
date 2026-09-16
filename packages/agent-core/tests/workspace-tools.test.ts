import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceAgentRuntime } from '../src/main/agent/runtime/runtime'
import {
  registerWorkspaceTools,
  workspaceListTool,
} from '../src/main/agent/runtime/tools/workspace-tools'

const fileStatHooks = vi.hoisted(() => ({
  pathStatDevice: undefined as bigint | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      if (fileStatHooks.pathStatDevice !== undefined && typeof result.dev === 'bigint') {
        result.dev = fileStatHooks.pathStatDevice
      }
      return result
    },
  }
})

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'janusx-workspace-tools-'))
  temporaryDirectories.push(directory)
  return directory
}

function autoApprove(runtime: WorkspaceAgentRuntime, approved = true) {
  runtime.onEvent((event) => {
    if (event.type !== 'approval-requested') return
    runtime.resolveApproval({
      approvalId: event.request.id,
      approved,
      workspaceId: event.request.workspaceId,
      sessionId: event.request.sessionId,
      correlationId: event.request.correlationId,
      toolName: event.request.toolName,
      actionRisk: event.request.actionRisk,
    })
  })
}

async function executeRead(root: string, path: string, maxBytes?: number, offset?: number, limit?: number, maxTokens?: number) {
  const runtime = new WorkspaceAgentRuntime(async () => root)
  registerWorkspaceTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
  return runtime.executeTool({
    sessionId: session.id,
    call: {
      toolName: 'workspace.read',
      input: {
        workspaceId: 'workspace-1',
        path,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
    },
  })
}

async function executeList(
  root: string,
  input: Record<string, unknown> = { workspaceId: 'workspace-1' },
) {
  const runtime = new WorkspaceAgentRuntime(async () => root)
  registerWorkspaceTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
  return runtime.executeTool({
    sessionId: session.id,
    call: { toolName: 'workspace.list', input },
  })
}

afterEach(async () => {
  fileStatHooks.pathStatDevice = undefined
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('workspace.read tool', () => {
  it('registers every workspace tool once and reads UTF-8 text through the runtime executor', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const runtime = new WorkspaceAgentRuntime(async () => root)

    registerWorkspaceTools(runtime.registry)
    registerWorkspaceTools(runtime.registry)

    expect(runtime.registry.list().filter(({ name }) => name === 'workspace.read')).toHaveLength(1)
    expect(runtime.registry.list().filter(({ name }) => name === 'workspace.list')).toHaveLength(1)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    await expect(runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-1', path: 'notes.txt' } },
    })).resolves.toMatchObject({
      status: 'completed',
      output: {
        workspaceId: 'workspace-1',
        path: 'notes.txt',
        encoding: 'utf-8',
        size: 15,
        content: 'hello workspace',
        sha256: createHash('sha256').update('hello workspace').digest('hex'),
      },
    })
  })

  it('returns secret-shaped source code verbatim so hash-bound edits stay possible', async () => {
    // Regression: display-level redaction used to rewrite `apiKey: ...` lines in
    // tool output, so the model could never produce a matching oldText again.
    const source = 'const apiKey = process.env.MY_KEY\nconst token = login()\n'
    const root = await temporaryDirectory()
    await writeFile(join(root, 'config.ts'), source, 'utf-8')

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const read = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-1', path: 'config.ts' } },
    })
    expect(read.status).toBe('completed')
    const output = read.output as { content: string; sha256: string; contentRedacted: boolean }
    expect(output.content).toBe(source)
    expect(output.contentRedacted).toBe(false)
    expect(output.sha256).toBe(createHash('sha256').update(source).digest('hex'))

    autoApprove(runtime)
    const edit = await runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: {
          workspaceId: 'workspace-1', path: 'config.ts', expectedHash: output.sha256,
          replacements: [{ oldText: 'const apiKey = process.env.MY_KEY', newText: 'const apiKey = process.env.RENAMED_KEY' }],
        },
        preview: { summary: 'Edit config.ts', paths: ['config.ts'], truncated: false },
      },
    })
    expect(edit.status).toBe('completed')
    expect(await readFile(join(root, 'config.ts'), 'utf-8')).toBe(
      'const apiKey = process.env.RENAMED_KEY\nconst token = login()\n',
    )
  })

  it('masks embedded private keys, flags the redaction, and keeps other regions editable', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'
    const source = `const label = 'hello'\nconst pem = \`${pem}\`\n`
    const root = await temporaryDirectory()
    await writeFile(join(root, 'cert.ts'), source, 'utf-8')

    const read = await executeRead(root, 'cert.ts')
    expect(read.status).toBe('completed')
    const output = read.output as { content: string; sha256: string; contentRedacted: boolean; redactionNotice?: string }
    expect(output.contentRedacted).toBe(true)
    expect(output.redactionNotice).toContain('masked')
    expect(output.content).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(output.content).toContain("const label = 'hello'")
    // Hash still covers the on-disk original, so unmasked regions remain editable.
    expect(output.sha256).toBe(createHash('sha256').update(source).digest('hex'))
  })

  it.each([
    ['sensitive', '.env', Buffer.from('SECRET=not-exposed')],
    ['binary', 'image.bin', Buffer.from([0x00, 0x01, 0x02, 0x03])],
    ['invalid UTF-8', 'invalid.txt', Buffer.from([0xc3, 0x28])],
  ])('fails closed for %s files', async (_case, path, content) => {
    const root = await temporaryDirectory()
    await writeFile(join(root, path), content)

    const result = await executeRead(root, path)

    expect(result.status).toBe('failed')
    expect(result.output).toBeUndefined()
    expect(result.error).not.toContain(content.toString())
  })

  it('fails closed for outside files and pages large files by lines', async () => {
    const state = await temporaryDirectory()
    const root = await temporaryDirectory()
    const outsidePath = join(state, 'outside.txt')
    await writeFile(outsidePath, 'outside secret')
    await writeFile(join(root, 'large.txt'), 'aaa\nbbb\nccc\n', 'utf-8')

    const outside = await executeRead(root, outsidePath)
    // Byte cap wins over the line cap: only the first line fits in 5 bytes.
    const paged = await executeRead(root, 'large.txt', 5, 1)

    expect(outside).toMatchObject({ status: 'failed', output: undefined })
    expect(outside.error).not.toContain('outside secret')
    expect(paged).toMatchObject({
      status: 'completed',
      output: {
        content: 'aaa',
        offset: 1,
        lineStart: 1,
        lineEnd: 1,
        totalLines: 4,
        bytes: 3,
        size: 'aaa\nbbb\nccc\n'.length,
        truncated: true,
        nextOffset: 2,
        sha256: createHash('sha256').update('aaa\nbbb\nccc\n').digest('hex'),
      },
    })
    expect((paged.output as { guidance: string }).guidance).toContain('offset=2')
  })

  it('reads a bounded line range with the complete file hash', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'large.txt'), 'l1\nl2\nl3\nl4\n', 'utf-8')

    const result = await executeRead(root, 'large.txt', undefined, 2, 2)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        content: 'l2\nl3',
        offset: 2,
        lineStart: 2,
        lineEnd: 3,
        totalLines: 5,
        truncated: true,
        nextOffset: 4,
        sha256: createHash('sha256').update('l1\nl2\nl3\nl4\n').digest('hex'),
      },
    })
  })

  it('walks every page to the end without repeating the head', async () => {
    const root = await temporaryDirectory()
    const source = 'one\ntwo\nthree\nfour\n'
    await writeFile(join(root, 'paged.txt'), source, 'utf-8')

    const first = await executeRead(root, 'paged.txt', undefined, 1, 2)
    const second = await executeRead(
      root, 'paged.txt', undefined,
      (first.output as { nextOffset: number }).nextOffset, 2,
    )
    const third = await executeRead(
      root, 'paged.txt', undefined,
      (second.output as { nextOffset: number }).nextOffset, 10,
    )

    expect(first).toMatchObject({ status: 'completed', output: { content: 'one\ntwo', truncated: true, nextOffset: 3 } })
    expect(second).toMatchObject({ status: 'completed', output: { content: 'three\nfour', truncated: true, nextOffset: 5 } })
    expect(third).toMatchObject({ status: 'completed', output: { content: '', truncated: false } })
    expect((second.output as { content: string }).content).not.toBe((first.output as { content: string }).content)
  })

  it('rejects limit 0 and offsets past the last line instead of looping on the head', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'a\nb\n', 'utf-8')

    const zeroLimit = await executeRead(root, 'notes.txt', undefined, 1, 0)
    const pastEnd = await executeRead(root, 'notes.txt', undefined, 99, 10)

    expect(zeroLimit).toMatchObject({ status: 'failed', output: undefined })
    expect(pastEnd).toMatchObject({ status: 'failed', output: undefined })
    expect(pastEnd.error).toContain('beyond end of file (3 lines total)')
  })

  it('rejects a range read whose full hash would exceed the file safety bound', async () => {
    const root = await temporaryDirectory()
    const file = join(root, 'too-large.txt')
    await writeFile(file, 'x')
    await truncate(file, 16 * 1024 * 1024 + 1)

    const result = await executeRead(root, 'too-large.txt', 1)
    expect(result).toMatchObject({
      status: 'failed',
      reasonCode: 'FILE_TOO_LARGE',
      output: undefined,
    })
    expect(result.error).toContain('workspace.search')
  })

  it('requires the explicit workspace resource id to match the session', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })

    const missing = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { path: 'notes.txt' } },
    })
    const mismatched = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-2', path: 'notes.txt' } },
    })

    expect(missing).toMatchObject({ status: 'failed', output: undefined })
    expect(missing.error).toContain('Invalid input for tool')
    expect(mismatched).toMatchObject({ status: 'failed', output: undefined })
    expect(mismatched.error).toContain('must match the active workspace resource')
  })
})

describe('workspace.edit tool', () => {
  async function executeEdit(root: string, expectedHash: string, approved: boolean, oldText = 'hello') {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: {
          workspaceId: 'workspace-1',
          path: 'notes.txt',
          expectedHash,
          replacements: [{ oldText, newText: 'updated' }],
        },
        preview: {
          summary: 'Edit notes.txt',
          paths: ['notes.txt'],
          detail: `- ${oldText}\n+ updated`,
          truncated: false,
        },
      },
    })
  }

  async function executeUnifiedDiff(root: string, expectedHash: string, unifiedDiff: string, approved = true) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: { workspaceId: 'workspace-1', path: 'notes.txt', expectedHash, unifiedDiff },
        preview: { summary: 'Edit notes.txt with a unified diff', paths: ['notes.txt'], detail: unifiedDiff, truncated: false },
      },
    })
  }

  it('applies an approved hash-bound replacement and returns a checkpoint', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')

    const result = await executeEdit(root, expectedHash, true)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes.txt',
        changedPaths: ['notes.txt'],
        previousHash: expectedHash,
        replacements: 1,
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('updated workspace')

    const nextTurnRead = await executeRead(root, 'notes.txt')
    expect(nextTurnRead).toMatchObject({
      status: 'completed',
      output: {
        content: 'updated workspace',
        sha256: createHash('sha256').update('updated workspace').digest('hex'),
      },
    })
  })

  it('pages multi-byte lines without splitting characters', async () => {
    const root = await temporaryDirectory()
    const source = 'a你\nb好\nc'
    await writeFile(join(root, 'unicode.txt'), source, 'utf-8')

    const result = await executeRead(root, 'unicode.txt', undefined, 2, 1)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        content: 'b好',
        offset: 2,
        lineStart: 2,
        lineEnd: 2,
        totalLines: 3,
        truncated: true,
        nextOffset: 3,
        sha256: createHash('sha256').update(source).digest('hex'),
      },
    })
  })

  it('applies an edit when Electron omits the path stat device on Windows', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')
    fileStatHooks.pathStatDevice = 0n

    await expect(executeEdit(root, expectedHash, true)).resolves.toMatchObject({
      status: 'completed',
      output: { path: 'notes.txt', previousHash: expectedHash },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('updated workspace')
  })

  it('does not write when approval is denied', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')

    const result = await executeEdit(root, expectedHash, false)

    expect(result).toMatchObject({ status: 'cancelled', output: undefined })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('hello workspace')
  })

  it('applies an approved, hash-bound single-file unified diff atomically', async () => {
    const root = await temporaryDirectory()
    const source = 'first\nbefore\nlast\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-before',
      '+after',
      ' last',
      '',
    ].join('\n')

    const result = await executeUnifiedDiff(root, createHash('sha256').update(source).digest('hex'), diff)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes.txt',
        changedPaths: ['notes.txt'],
        editMode: 'unified_diff',
        replacements: 1,
        sha256: createHash('sha256').update('first\nafter\nlast\n').digest('hex'),
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\nafter\nlast\n')
  })

  it('preserves the standard trailing newline when a unified diff creates a file body', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), '', 'utf-8')
    const diff = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -0,0 +1 @@', '+first', ''].join('\n')

    await expect(executeUnifiedDiff(root, createHash('sha256').update('').digest('hex'), diff)).resolves.toMatchObject({
      status: 'completed',
      output: { sha256: createHash('sha256').update('first\n').digest('hex') },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\n')
  })

  it('rejects unified diffs with stale content, mismatched paths, or multiple file sections without writing', async () => {
    const root = await temporaryDirectory()
    const source = 'before\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const expectedHash = createHash('sha256').update(source).digest('hex')
    const mismatchedContext = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-different', '+after', ''].join('\n')
    const mismatchedPath = ['--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@', '-before', '+after', ''].join('\n')
    const multipleFiles = [
      '--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-before', '+after',
      '--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@', '-x', '+y', '',
    ].join('\n')

    for (const diff of [mismatchedContext, mismatchedPath, multipleFiles]) {
      await expect(executeUnifiedDiff(root, expectedHash, diff)).resolves.toMatchObject({
        status: 'failed',
      })
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe(source)
    }
  })

  it('does not write a unified diff when the hash is stale or approval is denied', async () => {
    const root = await temporaryDirectory()
    const source = 'before\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const diff = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-before', '+after', ''].join('\n')

    await expect(executeUnifiedDiff(root, '0'.repeat(64), diff)).resolves.toMatchObject({
      status: 'failed',
      reasonCode: 'TARGET_CHANGED',
    })
    await expect(executeUnifiedDiff(root, createHash('sha256').update(source).digest('hex'), diff, false)).resolves.toMatchObject({
      status: 'cancelled',
      reasonCode: 'APPROVAL_DENIED',
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe(source)
  })

  it('fails closed on a stale hash or ambiguous replacement', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello hello', 'utf-8')
    const currentHash = createHash('sha256').update('hello hello').digest('hex')

    const stale = await executeEdit(root, '0'.repeat(64), true)
    const ambiguous = await executeEdit(root, currentHash, true)

    expect(stale).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(ambiguous).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('hello hello')
  })

  it('matches LF oldText against a CRLF file and keeps the CRLF style', async () => {
    const root = await temporaryDirectory()
    const source = 'first\r\nsecond\r\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const expectedHash = createHash('sha256').update(source).digest('hex')

    const result = await executeEdit(root, expectedHash, true, 'second')

    expect(result).toMatchObject({ status: 'completed' })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\r\nupdated\r\n')
  })

  it('returns the current sha256 when the expected hash is stale', async () => {
    const root = await temporaryDirectory()
    const source = 'hello workspace'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const currentHash = createHash('sha256').update(source).digest('hex')

    const result = await executeEdit(root, '0'.repeat(64), true)

    expect(result).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(result.error).toContain(currentHash)
  })

  it('reports file size and the anchor line when a replacement misses', async () => {
    const root = await temporaryDirectory()
    const source = 'alpha\nbeta\ngamma\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const expectedHash = createHash('sha256').update(source).digest('hex')

    const result = await executeEdit(root, expectedHash, true, 'beta\nWRONG')

    expect(result).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(result.error).toContain('3 lines')
    expect(result.error).toContain('line 2')
  })

  // Note: pi-style hash-anchored line edits — see .agents/notes/implemented/feature/2026-09-15-write-anchor-chain.md
  describe('hash-anchored lineEdits', () => {
    async function readWithAnchors(root: string, path: string, offset?: number) {
      const runtime = new WorkspaceAgentRuntime(async () => root)
      registerWorkspaceTools(runtime.registry)
      const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
      const read = await runtime.executeTool({
        sessionId: session.id,
        call: {
          toolName: 'workspace.read',
          input: { workspaceId: 'workspace-1', path, withLineAnchors: true, ...(offset ? { offset } : {}) },
        },
      })
      if (read.status !== 'completed') throw new Error(read.error ?? 'read failed')
      return read.output as {
        sha256: string
        lineAnchors: string[]
        lineStart: number
        lineEnd: number
      }
    }

    async function executeLineEdit(
      root: string,
      expectedHash: string,
      lineEdits: Array<{ line: number; anchor: string; newText: string }>,
      approved = true,
    ) {
      const runtime = new WorkspaceAgentRuntime(async () => root)
      registerWorkspaceTools(runtime.registry)
      const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
      autoApprove(runtime, approved)
      return runtime.executeTool({
        sessionId: session.id,
        call: {
          toolName: 'workspace.edit',
          input: { workspaceId: 'workspace-1', path: 'notes.txt', expectedHash, lineEdits },
          preview: { summary: 'Edit notes.txt with line edits', paths: ['notes.txt'], truncated: false },
        },
      })
    }

    it('returns LINE#HASH anchors with the page and applies a two-line anchored edit', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf-8')

      const page = await readWithAnchors(root, 'notes.txt')
      expect(page.lineAnchors).toHaveLength(4)
      expect(page.lineAnchors[0]).toMatch(/^1#[a-f0-9]{8}$/)
      expect(page.lineAnchors[3]).toMatch(/^4#[a-f0-9]{8}$/)
      const anchor = (line: number) => page.lineAnchors[line - 1]!.split('#')[1]!

      const result = await executeLineEdit(root, page.sha256, [
        { line: 2, anchor: anchor(2), newText: 'BETA' },
        { line: 4, anchor: anchor(4), newText: 'DELTA\nDELTA-2' },
      ])

      expect(result).toMatchObject({ status: 'completed', output: { editMode: 'line_edits', replacements: 2 } })
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('alpha\nBETA\ngamma\nDELTA\nDELTA-2\n')
    })

    it('anchors apply bottom-up so line numbers before an insertion stay valid', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'one\ntwo\nthree\n', 'utf-8')

      const page = await readWithAnchors(root, 'notes.txt')
      const anchor = (line: number) => page.lineAnchors[line - 1]!.split('#')[1]!

      // Inserting at line 1 shifts every later line, but bottom-up order means
      // line 3's anchor was verified against the original array first.
      const result = await executeLineEdit(root, page.sha256, [
        { line: 1, anchor: anchor(1), newText: 'zero\nzero-b' },
        { line: 3, anchor: anchor(3), newText: 'THREE' },
      ])

      expect(result.status).toBe('completed')
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('zero\nzero-b\ntwo\nTHREE\n')
    })

    it('keeps the CRLF style of a CRLF file', async () => {
      const root = await temporaryDirectory()
      const source = 'first\r\nsecond\r\n'
      await writeFile(join(root, 'notes.txt'), source, 'utf-8')

      const page = await readWithAnchors(root, 'notes.txt')
      const anchor = page.lineAnchors[1]!.split('#')[1]!

      const result = await executeLineEdit(root, page.sha256, [{ line: 2, anchor, newText: 'SECOND' }])

      expect(result.status).toBe('completed')
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\r\nSECOND\r\n')
    })

    it('aborts the whole batch on a stale anchor and returns fresh anchors without writing', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf-8')

      const stalePage = await readWithAnchors(root, 'notes.txt')
      const staleAnchor = (line: number) => stalePage.lineAnchors[line - 1]!.split('#')[1]!
      // The file changes after the read (e.g. an earlier edit landed).
      await writeFile(join(root, 'notes.txt'), 'alpha\nbeta!\ngamma\ndelta\n', 'utf-8')
      const freshPage = await readWithAnchors(root, 'notes.txt')
      const freshAnchor = (line: number) => freshPage.lineAnchors[line - 1]!.split('#')[1]!

      const result = await executeLineEdit(root, freshPage.sha256, [
        { line: 1, anchor: staleAnchor(1), newText: 'A' },
        { line: 2, anchor: staleAnchor(2), newText: 'B' },
      ])

      expect(result).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
      expect(result.error).toContain('line 2')
      expect(result.error).toContain(freshAnchor(1))
      expect(result.error).toContain(freshAnchor(2))
      expect(result.error.toLowerCase()).toContain('fresh anchors')
      // Whole batch aborted: line 1 was never written even though its anchor matched.
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('alpha\nbeta!\ngamma\ndelta\n')
    })

    it('rejects duplicate line targets and lines beyond the file', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'one\ntwo\n', 'utf-8')
      const page = await readWithAnchors(root, 'notes.txt')
      const anchor = (line: number) => page.lineAnchors[line - 1]!.split('#')[1]!

      const duplicate = await executeLineEdit(root, page.sha256, [
        { line: 1, anchor: anchor(1), newText: 'a' },
        { line: 1, anchor: anchor(1), newText: 'b' },
      ])
      expect(duplicate.status).toBe('failed')
      expect(duplicate.error).toContain('line 1')

      const beyond = await executeLineEdit(root, page.sha256, [{ line: 9, anchor: anchor(1), newText: 'x' }])
      expect(beyond.status).toBe('failed')
      expect(beyond.error).toContain('9')
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('one\ntwo\n')
    })

    it('requires exactly one edit mode and rejects malformed anchors', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'one\n', 'utf-8')
      const page = await readWithAnchors(root, 'notes.txt')
      const anchor = page.lineAnchors[0]!.split('#')[1]!

      const valid = await executeLineEdit(root, page.sha256, [{ line: 1, anchor, newText: 'x' }])
      expect(valid.status).toBe('completed')
      await writeFile(join(root, 'notes.txt'), 'one\n', 'utf-8')

      const runtime = new WorkspaceAgentRuntime(async () => root)
      registerWorkspaceTools(runtime.registry)
      // auto-run: the malformed anchor must fail in the tool itself, not at
      // an approval gate nobody resolves in this test.
      const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root, approvalMode: 'auto-run' })
      const malformed = await runtime.executeTool({
        sessionId: session.id,
        call: {
          toolName: 'workspace.edit',
          input: {
            workspaceId: 'workspace-1', path: 'notes.txt', expectedHash: createHash('sha256').update('one\n').digest('hex'),
            lineEdits: [{ line: 1, anchor: 'nothex!', newText: 'x' }],
          },
          preview: { summary: 'Edit notes.txt with line edits', paths: ['notes.txt'], truncated: false },
        },
      })
      expect(malformed.status).toBe('failed')
      expect(malformed.error).toContain('anchor')
    })

    it('reads anchors from a later page with page-relative line numbers intact', async () => {
      const root = await temporaryDirectory()
      await writeFile(join(root, 'notes.txt'), 'l1\nl2\nl3\nl4\nl5\n', 'utf-8')

      const page = await readWithAnchors(root, 'notes.txt', 3)
      expect(page.lineStart).toBe(3)
      // The anchor array covers exactly the returned page (lines 3-5).
      expect(page.lineAnchors[0]).toMatch(/^3#/)
      expect(page.lineAnchors).toHaveLength(3)
      const anchor = page.lineAnchors[0]!.split('#')[1]!

      const result = await executeLineEdit(root, page.sha256, [{ line: 3, anchor, newText: 'L3' }])
      expect(result.status).toBe('completed')
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('l1\nl2\nL3\nl4\nl5\n')
    })
  })
})

describe('workspace.create tool', () => {
  async function executeCreate(root: string, path: string, content: string, approved = true) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.create',
        input: { workspaceId: 'workspace-1', path, content },
        preview: { summary: `Create ${path}`, paths: [path], truncated: false },
      },
    })
  }

  it('creates an approved new file with checkpoint and hash', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'notes'))

    const result = await executeCreate(root, 'notes/test.md', '# hello\n')

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes/test.md',
        changedPaths: ['notes/test.md'],
        sha256: createHash('sha256').update('# hello\n').digest('hex'),
        bytes: 8,
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes/test.md'), 'utf-8')).toBe('# hello\n')
  })

  it('does not create when approval is denied', async () => {
    const root = await temporaryDirectory()
    const result = await executeCreate(root, 'test.md', 'content', false)
    expect(result).toMatchObject({ status: 'cancelled', reasonCode: 'APPROVAL_DENIED' })
    await expect(readFile(join(root, 'test.md'), 'utf-8')).rejects.toThrow()
  })

  it.each([
    ['existing file', async (root: string) => { await writeFile(join(root, 'exists.txt'), 'x') }, 'exists.txt'],
    ['missing parent', async () => {}, 'missing/child.txt'],
    ['sensitive path', async () => {}, '.env.production'],
    ['traversal', async () => {}, '../escape.txt'],
  ])('fails closed for %s', async (_case, prepare, path) => {
    const root = await temporaryDirectory()
    await prepare(root)
    const result = await executeCreate(root, path, 'content')
    expect(result.status).toBe('failed')
  })

  it('points an existing target at workspace.edit', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'exists.txt'), 'x')

    const result = await executeCreate(root, 'exists.txt', 'content')

    expect(result.status).toBe('failed')
    expect(result.error).toContain('workspace.edit')
  })
})

describe('per-call change diffs', () => {
  async function executeCall(root: string, toolName: string, input: Record<string, unknown>) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, true)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName,
        input: { workspaceId: 'workspace-1', ...input },
        preview: { summary: `${toolName} preview`, paths: [String(input.path)], truncated: false },
      },
    })
  }

  it('attaches the applied replacement bytes to workspace.edit output', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')

    const result = await executeCall(root, 'workspace.edit', {
      path: 'notes.txt',
      expectedHash,
      replacements: [{ oldText: 'hello', newText: 'updated' }],
    })

    expect(result).toMatchObject({
      status: 'completed',
      output: { checkpointId: expect.any(String), diffTruncated: false },
    })
    const diff = String((result.output as Record<string, unknown>).diffPreview)
    expect(diff).toContain('--- a/notes.txt')
    expect(diff).toContain('@@ replacement 1/1 @@')
    expect(diff).toContain('-hello')
    expect(diff).toContain('+updated')
  })

  it('echoes the applied unified diff on workspace.edit output', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'first\nbefore\nlast\n', 'utf-8')
    const expectedHash = createHash('sha256').update('first\nbefore\nlast\n').digest('hex')
    const unifiedDiff = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1,3 +1,3 @@', ' first', '-before', '+after', ' last', ''].join('\n')

    const result = await executeCall(root, 'workspace.edit', { path: 'notes.txt', expectedHash, unifiedDiff })

    expect(result).toMatchObject({ status: 'completed', output: { diffPreview: unifiedDiff, diffTruncated: false } })
  })

  it('attaches new-file lines to workspace.create output', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'notes'))

    const result = await executeCall(root, 'workspace.create', { path: 'notes/test.md', content: '# hello\n' })

    expect(result).toMatchObject({ status: 'completed', output: { diffTruncated: false } })
    const diff = String((result.output as Record<string, unknown>).diffPreview)
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+# hello')
  })

  it('attaches removed lines to workspace.delete output', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'old.md'), 'gone\n', 'utf-8')

    const result = await executeCall(root, 'workspace.delete', { path: 'old.md' })

    expect(result).toMatchObject({ status: 'completed', output: { diffTruncated: false } })
    const diff = String((result.output as Record<string, unknown>).diffPreview)
    expect(diff).toContain('--- a/old.md')
    expect(diff).toContain('+++ /dev/null')
    expect(diff).toContain('-gone')
  })

  it('omits the preview for oversized sources so cards fall back to summary', async () => {
    const root = await temporaryDirectory()
    const big = 'x'.repeat(300 * 1024)
    await writeFile(join(root, 'big.txt'), big, 'utf-8')
    await mkdir(join(root, 'notes'))

    const created = await executeCall(root, 'workspace.create', { path: 'notes/big.md', content: big })
    expect(created).toMatchObject({ status: 'completed' })
    expect((created.output as Record<string, unknown>).diffPreview).toBeUndefined()
  })
})

describe('workspace.search tool', () => {
  async function executeSearch(root: string, input: Record<string, unknown>) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    return runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', ...input } },
    })
  }

  it('finds case-insensitive matches with paths and line numbers, skipping noise directories', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'main.ts'), 'const Needle = 1\nother\nlower needle here\n')
    await writeFile(join(root, 'node_modules', 'dep.js'), 'needle in dependency')
    await writeFile(join(root, '.env'), 'NEEDLE=secret')

    const result = await executeSearch(root, { query: 'needle' })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      truncated: false,
      matches: [
        {
          path: 'src/main.ts',
          matchCount: 2,
          hunks: [
            {
              start: 1,
              end: 3,
              lines: [
                { line: 1, text: 'const Needle = 1', hit: true },
                { line: 2, text: 'other', hit: false },
                { line: 3, text: 'lower needle here', hit: true },
              ],
            },
          ],
        },
      ],
    })
  })

  it('caps results and reports truncation', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'many.txt'), Array.from({ length: 10 }, () => 'match').join('\n'))

    const result = await executeSearch(root, { query: 'match', maxResults: 3 })

    expect(result.status).toBe('completed')
    const capped = result.output as { matches: Array<{ matchCount: number }> }
    expect(capped.matches).toHaveLength(1)
    expect(capped.matches[0].matchCount).toBe(3)
    expect(result.output).toMatchObject({ truncated: true })
  })

  it('finds filenames with glob and respects ignore files in native search', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, '.gitignore'), 'ignored.ts\n')
    await writeFile(join(root, 'ignored.ts'), 'needle')
    await writeFile(join(root, 'src', 'auth.ts'), 'needle')
    await writeFile(join(root, 'src', 'auth.md'), 'needle')
    const result = await executeSearch(root, { mode: 'files', glob: '**/*.ts' })
    expect(result.status).toBe('completed')
    const output = result.output as { backend: string; matches: Array<{ path: string }> }
    expect(output.matches).toContainEqual({ path: 'src/auth.ts' })
    expect(output.matches).not.toContainEqual({ path: 'src/auth.md' })
    if (output.backend === 'ripgrep') expect(output.matches).not.toContainEqual({ path: 'ignored.ts' })
  })

  it('supports regex alternatives and case-sensitive search', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'code.ts'), 'function Foo() {}\nfunction Bar() {}\nfunction foo() {}')
    const result = await executeSearch(root, { query: 'Foo|Bar', regex: true, caseSensitive: true })
    if (result.status !== 'completed') {
      expect(result.error).toContain('requires ripgrep')
      return
    }
    const groups = (result.output as { matches: Array<{ matchCount: number }> }).matches
    expect(groups).toHaveLength(1)
    expect(groups[0].matchCount).toBe(2)
  })

  it('bounds complete match records and preserves truncation guidance', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'many.ts'), Array.from({ length: 100 }, () => 'needle ' + 'x'.repeat(500)).join('\n'))
    const result = await executeSearch(root, { query: 'needle', maxResults: 50 })
    const output = result.output as { matches: Array<{ matchCount: number }>; truncated: boolean; guidance: string }
    expect(result.status).toBe('completed')
    const hits = output.matches.reduce((total, group) => total + group.matchCount, 0)
    expect(hits).toBeGreaterThan(20)
    expect(JSON.stringify(output.matches).length).toBeLessThan(41000)
    expect(output.truncated).toBe(true)
    expect(output.guidance).toContain('Narrow')
  })

  it('provides a truthful bounded fallback without ripgrep', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'code.ts'), 'needle')
    vi.stubEnv('PATH', '')
    try {
      const result = await executeSearch(root, { query: 'needle', glob: '**/*.ts' })
      expect(result.status).toBe('completed')
      expect(result.output).toMatchObject({
        backend: 'node',
        matches: [{ path: 'code.ts', matchCount: 1 }],
        note: expect.stringContaining('ignore files are not applied'),
      })
      const hunk = (result.output as { matches: Array<{ hunks: Array<{ lines: Array<{ line: number; text: string; hit: boolean }> }> }> }).matches[0].hunks[0]
      expect(hunk.lines).toEqual([{ line: 1, text: 'needle', hit: true }])
    } finally { vi.unstubAllEnvs() }
  })

  it('rejects explicitly scoped sensitive paths', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, '.env'), 'needle')
    expect((await executeSearch(root, { query: 'needle', path: '.env' })).status).not.toBe('completed')
  })

  it('rejects blank or oversized queries', async () => {
    const root = await temporaryDirectory()
    expect((await executeSearch(root, { query: '   ' })).status).toBe('failed')
    expect((await executeSearch(root, { query: 'x'.repeat(300) })).status).toBe('failed')
  })

  it('scopes to the file when path points to a file instead of failing', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.ts'), 'needle here\n')
    await writeFile(join(root, 'other.ts'), 'needle there\n')

    const result = await executeSearch(root, { query: 'needle', path: 'src/main.ts' })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      path: 'src',
      scopedFile: 'src/main.ts',
      matches: [{ path: 'src/main.ts', matchCount: 1 }],
      note: expect.stringContaining('scoped'),
    })
  })
})

describe('workspace.list tool', () => {
  it('executes as a read-only list action', async () => {
    const root = await temporaryDirectory()
    const runtime = new WorkspaceAgentRuntime(async () => root)

    registerWorkspaceTools(runtime.registry)
    expect(runtime.registry.get('workspace.list')?.actionRisk).toBe('list')
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    await expect(runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.list', input: { workspaceId: 'workspace-1' } },
    })).resolves.toMatchObject({
      status: 'completed',
      reasonCode: 'READ_ONLY_ALLOWED',
      policyDecision: { approvalDecision: 'not-required' },
    })
  })

  it('returns a deterministic tree bounded by depth', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'root.txt'), 'root')
    await writeFile(join(root, 'src', 'index.ts'), 'index')
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'deep')

    const result = await executeList(root, {
      workspaceId: 'workspace-1',
      path: '',
      depth: 2,
      maxEntries: 20,
    })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        workspaceId: 'workspace-1',
        path: '',
        depth: 2,
        truncated: false,
        entries: [
          { path: 'src', name: 'src', type: 'directory', depth: 1 },
          { path: 'src/nested', name: 'nested', type: 'directory', depth: 2 },
          { path: 'src/index.ts', name: 'index.ts', type: 'file', depth: 2 },
          { path: 'root.txt', name: 'root.txt', type: 'file', depth: 1 },
        ],
      },
    })
  })

  it.each(['../outside', 'C:\\outside', '/outside'])(
    'rejects paths outside the workspace: %s',
    async (path) => {
      const root = await temporaryDirectory()
      const result = await executeList(root, { workspaceId: 'workspace-1', path })

      expect(result).toMatchObject({ status: 'failed', output: undefined })
      expect(['ABSOLUTE_PATH', 'PATH_TRAVERSAL']).toContain(result.reasonCode)
    },
  )

  it('omits sensitive files, directories, and git metadata', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'secrets'))
    await writeFile(join(root, '.env.local'), 'TOKEN=secret')
    await writeFile(join(root, 'id_rsa'), 'private key')
    await writeFile(join(root, '.git', 'config'), 'git config')
    await writeFile(join(root, 'secrets', 'credentials.json'), 'credentials')
    await writeFile(join(root, 'visible.txt'), 'visible')

    const result = await executeList(root, { workspaceId: 'workspace-1', depth: 4 })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      entries: [{ path: 'visible.txt', name: 'visible.txt', type: 'file', depth: 1 }],
    })
  })

  it('does not follow symbolic links', async () => {
    const state = await temporaryDirectory()
    const root = join(state, 'workspace')
    const outside = join(state, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    try {
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return
      throw error
    }

    const result = await executeList(root, { workspaceId: 'workspace-1', depth: 4 })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        entries: [{ path: 'inside.txt' }],
      },
    })
    expect(JSON.stringify(result.output)).not.toContain('secret.txt')
  })

  it('enforces entry limits and reports truncation', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'c.txt'), 'c')
    // Distinct mtimes keep the recency order deterministic across filesystems.
    const now = Date.now() / 1000
    await utimes(join(root, 'a.txt'), now - 30, now - 30)
    await utimes(join(root, 'b.txt'), now - 20, now - 20)
    await utimes(join(root, 'c.txt'), now - 10, now - 10)

    const result = await executeList(root, { workspaceId: 'workspace-1', maxEntries: 2 })
    const invalidDepth = await executeList(root, { workspaceId: 'workspace-1', depth: 5 })
    const invalidMaxEntries = await executeList(root, { workspaceId: 'workspace-1', maxEntries: 1001 })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        entries: [{ path: 'c.txt' }, { path: 'b.txt' }],
        truncated: true,
      },
    })
    expect(invalidDepth).toMatchObject({ status: 'failed', output: undefined })
    expect(invalidMaxEntries).toMatchObject({ status: 'failed', output: undefined })
  })

  it('stops before filesystem access when cancelled', async () => {
    const root = await temporaryDirectory()
    const controller = new AbortController()
    controller.abort()

    await expect(workspaceListTool.execute(
      { workspaceId: 'workspace-1' },
      { workspaceId: 'workspace-1', workspaceRoot: root, signal: controller.signal },
    )).rejects.toThrow('workspace.list cancelled')
  })

  it('carries sizes and modification times with recently modified files first', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'old.txt'), 'old-content')
    await writeFile(join(root, 'new.txt'), 'new-content!')
    const now = Date.now() / 1000
    await utimes(join(root, 'old.txt'), now - 60, now - 60)
    await utimes(join(root, 'new.txt'), now - 5, now - 5)

    const result = await executeList(root, { workspaceId: 'workspace-1' })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        truncated: false,
        entries: [
          { path: 'new.txt', name: 'new.txt', type: 'file', depth: 1, size: 12 },
          { path: 'old.txt', name: 'old.txt', type: 'file', depth: 1, size: 11 },
        ],
      },
    })
    const entries = (result.output as { entries: Array<{ mtime: number }> }).entries
    expect(typeof entries[0].mtime).toBe('number')
    expect(entries[0].mtime).toBeGreaterThanOrEqual(entries[1].mtime)
    expect((result.output as { estimatedTokens: number }).estimatedTokens).toBeGreaterThan(0)
  })

  it('truncates entries under an explicit token budget with counts and guidance', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'a.txt'), 'a'.repeat(2000))
    await writeFile(join(root, 'b.txt'), 'b'.repeat(2000))

    const result = await executeList(root, { workspaceId: 'workspace-1', maxTokens: 20 })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        truncated: true,
        totalEntries: 2,
        guidance: expect.stringContaining('maxTokens=20'),
      },
    })
    const output = result.output as { entries: unknown[]; totalTokens: number }
    expect(output.entries.length).toBeLessThan(2)
    expect(output.totalTokens).toBeGreaterThan(20)
  })
})

describe('adaptive workspace.read pages', () => {
  it('covers a 600-line file in one default read', async () => {
    const root = await temporaryDirectory()
    const lines = Array.from({ length: 600 }, (_, index) => `line ${index + 1} with some content`)
    await writeFile(join(root, 'medium.ts'), lines.join('\n') + '\n', 'utf-8')

    const result = await executeRead(root, 'medium.ts')

    expect(result).toMatchObject({ status: 'completed' })
    const output = result.output as { content: string; truncated: boolean; lineStart: number; lineEnd: number; totalLines: number; estimatedTokens: number }
    expect(output.truncated).toBe(false)
    expect(output.lineStart).toBe(1)
    expect(output.lineEnd).toBe(601)
    expect(output.content).toBe(lines.join('\n') + '\n')
    expect(output.estimatedTokens).toBeGreaterThan(0)
  })

  it('pages files over 100KB with the 800-line/48KB defaults', async () => {
    const root = await temporaryDirectory()
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${String(index + 1).padStart(4, '0')} ${'x'.repeat(95)}`)
    await writeFile(join(root, 'big.ts'), lines.join('\n') + '\n', 'utf-8')

    const first = await executeRead(root, 'big.ts')
    expect(first).toMatchObject({ status: 'completed' })
    const firstOutput = first.output as { truncated: boolean; lineStart: number; lineEnd: number; totalLines: number; nextOffset: number; bytes: number }
    expect(firstOutput.truncated).toBe(true)
    expect(firstOutput.lineStart).toBe(1)
    expect(firstOutput.lineEnd).toBeLessThanOrEqual(800)
    expect(firstOutput.bytes).toBeLessThanOrEqual(48 * 1024 + 200)
    expect(firstOutput.nextOffset).toBe(firstOutput.lineEnd + 1)

    const second = await executeRead(root, 'big.ts', undefined, firstOutput.nextOffset)
    const secondOutput = second.output as { content: string; lineStart: number }
    expect(second).toMatchObject({ status: 'completed' })
    expect(secondOutput.lineStart).toBe(firstOutput.nextOffset)
    expect(secondOutput.content.split('\n')[0]).toBe(lines[firstOutput.nextOffset - 1])
  })

  it('truncates a page under an explicit token budget with counts and guidance', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n'), 'utf-8')

    const result = await executeRead(root, 'notes.txt', undefined, undefined, undefined, 10)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        truncated: true,
        guidance: expect.stringContaining('maxTokens=10'),
      },
    })
    const output = result.output as { totalTokens: number; estimatedTokens: number; content: string }
    expect(output.totalTokens).toBeGreaterThan(10)
    expect(output.estimatedTokens).toBeLessThanOrEqual(output.totalTokens)
    expect(output.content.length).toBeGreaterThan(0)
  })
})

describe('workspace.search evidence density', () => {
  async function executeSearchWithApproval(root: string) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    autoApprove(runtime, true)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    return { runtime, session }
  }

  it('groups clustered hits into one hunk with a shared file hash', async () => {
    const root = await temporaryDirectory()
    const source = ['first line', 'second has needle', 'third line', 'fourth line'].join('\n') + '\n'
    await writeFile(join(root, 'code.ts'), source, 'utf-8')

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const result = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'needle' } },
    })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      matches: [{
        path: 'code.ts',
        matchCount: 1,
        sha256: createHash('sha256').update(source).digest('hex'),
        hunks: [{
          start: 1,
          end: 4,
          lines: [
            { line: 1, text: 'first line', hit: false },
            { line: 2, text: 'second has needle', hit: true },
            { line: 3, text: 'third line', hit: false },
            { line: 4, text: 'fourth line', hit: false },
          ],
        }],
      }],
    })
  })

  it('marks skipped lines between distant hunks instead of repeating context', async () => {
    const root = await temporaryDirectory()
    const lines = ['needle top', ...Array.from({ length: 20 }, (_, index) => `filler ${index}`), 'needle bottom']
    await writeFile(join(root, 'split.ts'), lines.join('\n') + '\n', 'utf-8')

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const result = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'needle' } },
    })

    expect(result.status).toBe('completed')
    const group = (result.output as { matches: Array<{ matchCount: number; hunks: Array<{ start: number; end: number; gapBefore?: number; lines: Array<{ line: number; hit: boolean }> }> }> }).matches[0]
    expect(group.matchCount).toBe(2)
    expect(group.hunks).toHaveLength(2)
    // First hunk covers lines 1-3, second covers 20-22 with an 16-line gap.
    expect(group.hunks[0].start).toBe(1)
    expect(group.hunks[1].gapBefore).toBe(16)
    expect(group.hunks[1].lines.filter((line) => line.hit).map((line) => line.line)).toEqual([22])
    // No line repeats across hunks: the shared context lands exactly once.
    const shown = group.hunks.flatMap((hunk) => hunk.lines.map((line) => line.line))
    expect(new Set(shown).size).toBe(shown.length)
  })

  it('edits with a search-carried hash and no second read', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'fix.ts'), 'const before = 1\n', 'utf-8')
    const { runtime, session } = await executeSearchWithApproval(root)

    const found = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'before' } },
    })
    expect(found.status).toBe('completed')
    const match = (found.output as { matches: Array<{ sha256: string }> }).matches[0]
    expect(typeof match.sha256).toBe('string')

    const edited = await runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: {
          workspaceId: 'workspace-1',
          path: 'fix.ts',
          expectedHash: match.sha256,
          replacements: [{ oldText: 'const before = 1', newText: 'const before = 2' }],
        },
        preview: { summary: 'Edit fix.ts', paths: ['fix.ts'], truncated: false },
      },
    })
    expect(edited.status).toBe('completed')
    expect(await readFile(join(root, 'fix.ts'), 'utf-8')).toBe('const before = 2\n')
  })

  it('orders filename hits by recency and accepts up to 100 results', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'old-name.ts'), 'x')
    await writeFile(join(root, 'new-name.ts'), 'x')
    const now = Date.now() / 1000
    await utimes(join(root, 'old-name.ts'), now - 60, now - 60)
    await utimes(join(root, 'new-name.ts'), now - 5, now - 5)

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const ordered = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', mode: 'files', query: '-name' } },
    })
    expect(ordered).toMatchObject({
      status: 'completed',
      output: { matches: [{ path: 'new-name.ts' }, { path: 'old-name.ts' }] },
    })

    const tooMany = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'x', maxResults: 101 } },
    })
    expect(tooMany.status).toBe('failed')

    await writeFile(join(root, 'many.txt'), Array.from({ length: 60 }, () => 'hit').join('\n'))
    const sixty = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'hit', maxResults: 60 } },
    })
    expect(sixty).toMatchObject({ status: 'completed' })
    const groups = (sixty.output as { matches: Array<{ path: string; matchCount: number; hunks: unknown[] }> }).matches
    expect(groups).toHaveLength(1)
    expect(groups[0].path).toBe('many.txt')
    expect(groups[0].matchCount).toBe(60)
    expect(groups[0].hunks.length).toBe(1)
  })

  it('truncates matches under an explicit token budget with counts and guidance', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'many.txt'), Array.from({ length: 30 }, () => 'needle here').join('\n'))

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const result = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', query: 'needle', maxTokens: 30 } },
    })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        truncated: true,
        totalResults: 30,
        guidance: expect.stringContaining('maxTokens=30'),
      },
    })
    const output = result.output as { matches: unknown[]; totalTokens: number }
    expect(output.matches.length).toBeLessThan(30)
    expect(output.totalTokens).toBeGreaterThan(30)
  })
})

describe('workspace.overview tool', () => {
  async function executeOverview(root: string, input: Record<string, unknown> = {}) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    return runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.overview', input: { workspaceId: 'workspace-1', ...input } },
    })
  }

  it('returns a shallow tree with sizes, times, and token counts', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'README.md'), '# hello')
    await writeFile(join(root, 'src', 'index.ts'), 'index')

    const result = await executeOverview(root)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        workspaceId: 'workspace-1',
        path: '',
        depth: 2,
        truncated: false,
        entries: [
          { path: 'src', type: 'directory', size: 0 },
          { path: 'src/index.ts', type: 'file', size: 5 },
          { path: 'README.md', type: 'file', size: 7 },
        ],
      },
    })
    const output = result.output as { entries: Array<{ mtime: number }>; estimatedTokens: number; git?: unknown }
    expect(output.entries.every((entry) => typeof entry.mtime === 'number')).toBe(true)
    expect(output.estimatedTokens).toBeGreaterThan(0)
    expect(output.git === undefined || typeof (output.git as { branch: string }).branch === 'string').toBe(true)
  })

  it('reports truncation when entries exceed the caps', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')

    const result = await executeOverview(root, { maxEntries: 1 })

    expect(result).toMatchObject({
      status: 'completed',
      output: { truncated: true },
    })
    expect((result.output as { entries: unknown[] }).entries).toHaveLength(1)
  })
})
