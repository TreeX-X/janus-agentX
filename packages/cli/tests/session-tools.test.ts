/**
 * CLI tool wiring: CliSession.create registers workspace + node-hosts tools
 * (command, git, background-job project tools) on the shared registry, so the
 * model sees the full host tool surface.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliSession, isSessionValidationError } from '../src/session.js'

const EXPECTED_TOOLS = [
  'workspace.read', 'workspace.list', 'workspace.search', 'workspace.edit', 'workspace.create',
  'command.run',
  'git.status', 'git.log', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.pull', 'git.push',
  'project.list-processes', 'project.process-output', 'project.stop-process',
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
})
