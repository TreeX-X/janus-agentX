import { describe, expect, it } from 'vitest';
import { parseNote, patchTaskExecution, taskContractHash, type TaskExecution } from '../src/index.js';

const source = ['---', 'schema: harness-note/1', 'id: 11111111-1111-4111-8111-111111111111 # keep', 'kind: task', "lifecycle: 'accepted'", 'created: 2026-09-18',
  'tags: [keep, formatting]', '---', '', '# Task', '', '## Scope', '', 'Keep prose.', '', '## Acceptance criteria', '', '- [ ] AC-1: works', '', '## Verification', '', 'Check.', '',
].join('\n');
const execution: TaskExecution = { mode: 'xdo', state: 'queued', baseline: { taskContractHash: 'a'.repeat(64), inputs: [] }, attempt: 0, receipts: [], closeout: 'commit-required' };

describe('execution-only edits', () => {
  it.each(['\n', '\r\n'] as const)('preserves BOM, other YAML and body with %j', (eol) => {
    const raw = '\ufeff' + source.replace(/\n/g, eol);
    const first = patchTaskExecution(raw, execution);
    const second = patchTaskExecution(first, { ...execution, state: 'running', attempt: 1 });
    expect(second.startsWith('\ufeff')).toBe(true);
    expect(second).toContain("lifecycle: 'accepted'");
    expect(second).toContain('id: 11111111-1111-4111-8111-111111111111 # keep');
    expect(second.slice(second.indexOf('# Task'))).toBe(raw.slice(raw.indexOf('# Task')));
    expect(taskContractHash(parseNote(second))).toBe(taskContractHash(parseNote(raw)));
    expect(parseNote(second).meta.execution?.attempt).toBe(1);
    if (eol === '\r\n') expect(second.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('preserves keys and comments after execution', () => {
    const first = patchTaskExecution(source, execution);
    const moved = first.replace('tags: [keep, formatting]\n', '').replace('\n---\n\n# Task', '\n# keep after execution\ntags: [keep, formatting]\n---\n\n# Task');
    const updated = patchTaskExecution(moved, { ...execution, state: 'running', attempt: 1 });
    expect(updated).toContain('# keep after execution\ntags: [keep, formatting]');
    expect(parseNote(updated).meta.tags).toEqual(['keep', 'formatting']);
  });
});
