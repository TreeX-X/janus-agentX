import { describe, expect, it } from 'vitest'
import { toDisplayEvent } from '../src/tool-display.js'

describe('tool display projection', () => {
  it('marks nonzero command exits as failures even when the host call completed', () => {
    const event = toDisplayEvent({ type: 'tool_execution_end', requestId: 'r', call: {
      id: 'c', name: 'command_run', arguments: { program: 'npm', args: ['test'] },
    }, result: { content: '', details: { toolName: 'command.run', status: 'completed', output: { exitCode: 1, stdout: 'test failed' } } }, isError: false })
    expect(event).toMatchObject({ display: { failed: true, target: 'program: npm · args: ["test"]', output: ['test failed'] } })
  })

  it('previews applied replacements but never presents a denied edit as applied', () => {
    const call = { id: 'c', name: 'workspace_edit', arguments: { path: 'a.ts', replacements: [{ oldText: 'before', newText: 'after' }] } }
    expect(toDisplayEvent({ type: 'tool_execution_end', requestId: 'r', call, result: { content: 'ok' }, isError: false }))
      .toMatchObject({ display: { output: ['-before', '+after'] } })
    expect(toDisplayEvent({ type: 'tool_execution_end', requestId: 'r', call, result: { content: 'denied' }, isError: true }))
      .toMatchObject({ display: { failed: true, output: ['denied'] } })
  })

  it('shows targets without exposing arbitrary arguments or terminal control sequences', () => {
    const event = toDisplayEvent({ type: 'tool_call_ready', requestId: 'r', call: {
      id: 'c', name: 'workspace_search', arguments: { path: 'src', query: '\x1b[2Jquery', apiKey: 'private', content: 'hidden argument body' },
    } })
    expect(event).toMatchObject({ type: 'tool-display', display: { category: 'search', target: 'path: src · query: query' } })
    expect(JSON.stringify(event)).not.toMatch(/private|hidden argument body|u001b/)
  })

  it('emits bounded command output, stderr, exit status and duration on completion', () => {
    const event = toDisplayEvent({ type: 'tool_execution_end', requestId: 'r', call: {
      id: 'c', name: 'command_run', arguments: { command: 'npm test' },
    }, result: { content: '', details: {
      toolName: 'command.run', status: 'completed', workspaceId: 'cli', durationMs: 1250,
      output: { stdout: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), stderr: 'warning', exitCode: 0 },
    } }, isError: false })
    expect(event).toMatchObject({ display: { category: 'command', durationMs: 1250, summary: 'exit=0' } })
    if (event?.type !== 'tool-display') throw new Error('missing display event')
    expect(event.display.output).toContain('[output truncated]')
    expect(event.display.output).toContain('stderr:')
    expect(event.display.output).toContain('warning')
    expect(event.display.output!.length).toBeLessThan(100)
  })

  it('keeps errors and redacts credentials in structured output', () => {
    const event = toDisplayEvent({ type: 'tool_execution_end', requestId: 'r', call: {
      id: 'c', name: 'custom', arguments: {},
    }, result: { content: '', details: {
      toolName: 'custom', status: 'failed', workspaceId: 'cli', error: 'permission denied',
      output: { apiKey: 'private', message: 'failure' },
    } }, isError: true })
    expect(event).toMatchObject({ display: { summary: 'permission denied' } })
    expect(JSON.stringify(event)).not.toContain('private')
    expect(JSON.stringify(event)).toContain('[REDACTED]')
  })
})
