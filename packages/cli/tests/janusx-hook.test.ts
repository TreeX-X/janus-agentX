/**
 * janusx-hook: env-gated hook delivery never breaks the CLI and posts the
 * Claude-compatible contract JanusX expects.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postJanusxHook, truncateHookMessage } from '../src/janusx-hook.js'

interface CapturedPost {
  auth: unknown
  body: Record<string, unknown>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

describe('postJanusxHook', () => {
  let server: Server
  let posts: CapturedPost[] = []
  let port = 0

  beforeEach(async () => {
    posts = []
    server = createServer(async (request, response) => {
      posts.push({
        auth: request.headers.authorization,
        body: JSON.parse(await readBody(request)) as Record<string, unknown>,
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('is a silent no-op without hook env', async () => {
    await expect(postJanusxHook({
      event: 'UserPromptSubmit',
      message: 'hi',
      env: {},
    })).resolves.toBeUndefined()
    expect(posts).toHaveLength(0)
  })

  it('posts the janus hook contract with bearer auth', async () => {
    await postJanusxHook({
      event: 'UserPromptSubmit',
      sessionId: 'conv-1',
      cwd: '/repo',
      message: 'do things',
      raw: { hook: 'send-turn' },
      env: {
        JANUSX_HOOK_PORT: String(port),
        JANUSX_HOOK_TOKEN: 'secret',
        JANUSX_HOOK_TERMINAL_ID: 'term-janus',
        JANUSX_HOOK_WORKSPACE_ID: 'workspace-1',
      },
    })

    expect(posts).toHaveLength(1)
    expect(posts[0].auth).toBe('Bearer secret')
    expect(posts[0].body).toMatchObject({
      source: 'janus',
      event: 'UserPromptSubmit',
      terminalId: 'term-janus',
      workspaceId: 'workspace-1',
      sessionId: 'conv-1',
      cwd: '/repo',
      message: 'do things',
    })
    expect((posts[0].body.raw as Record<string, unknown>).hook).toBe('send-turn')
  })

  it('survives an unreachable bridge', async () => {
    await expect(postJanusxHook({
      event: 'Stop',
      env: { JANUSX_HOOK_PORT: '1', JANUSX_HOOK_TOKEN: 'secret' },
    })).resolves.toBeUndefined()
  })
})

describe('truncateHookMessage', () => {
  it('bounds long prompts and drops blanks', () => {
    expect(truncateHookMessage(undefined)).toBeUndefined()
    expect(truncateHookMessage('   ')).toBeUndefined()
    expect(truncateHookMessage('hi')).toBe('hi')
    expect(truncateHookMessage('x'.repeat(600))).toHaveLength(500)
  })
})
