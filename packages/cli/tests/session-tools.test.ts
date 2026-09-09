/**
 * CLI tool wiring: CliSession.create registers workspace + node-hosts tools
 * (command, git, project incl. detect, background-job tools) on the shared
 * registry, so the model sees the full host tool surface — and everything
 * offered is executable (no advertised-but-missing tools like project.detect
 * used to be).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliSession, isSessionValidationError } from '../src/session.js'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'

const EXPECTED_TOOLS = [
  'workspace.read', 'workspace.list', 'workspace.search', 'workspace.edit', 'workspace.create',
  'command.run',
  'git.status', 'git.log', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.pull', 'git.push',
  'project.detect', 'project.list-processes', 'project.process-output', 'project.stop-process',
]

describe('CliSession tool wiring', () => {
  it('registers workspace + node-hosts tools on the shared registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-cli-wiring-'))
    const session = await CliSession.create({ workspace: dir, model: 'm' })
    if (isSessionValidationError(session)) throw new Error(session.message)
    try {
      // Private ports surface, read-only here: asserts wiring, not behavior.
      const ports = (session as unknown as { ports: { tools: { registry: { list(): Array<{ name: string }> } } } }).ports
      const names = new Set(ports.tools.registry.list().map((tool) => tool.name))
      for (const name of EXPECTED_TOOLS) {
        expect(names.has(name), `missing tool: ${name}`).toBe(true)
      }
    } finally {
      await session.close()
    }
  })

  it('executes a model-called project_detect against the tmp workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-cli-detect-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }))
    let calls = 0
    const session = await CliSession.create({
      workspace: dir,
      model: 'm',
      apiKey: 'k',
      streamTextFn: (async () => {
        calls += 1
        if (calls === 1) {
          return {
            fullStream: (async function* () {
              yield {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'project_detect',
                args: { workspaceId: 'cli', path: '', depth: 1, maxDirectories: 50 },
              }
              yield { type: 'finish', finishReason: 'tool-calls' }
            })(),
            textStream: (async function* () { })(),
          }
        }
        return { textStream: (async function* () { yield 'node project detected' })() }
      }) as ChatTurnPorts['streamTextFn'],
    })
    if (isSessionValidationError(session)) throw new Error(session.message)
    try {
      const result = await session.sendTurn('what kind of project is this?')
      expect(result.cancelled).toBe(false)
      const trace = result.toolTraces.find((entry) => entry.toolName === 'project.detect')
      expect(trace?.status).toBe('completed')
      expect(result.text).toContain('node project detected')
    } finally {
      await session.close()
    }
  })
})
