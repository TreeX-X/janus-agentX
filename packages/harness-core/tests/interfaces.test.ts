import { describe, expect, it } from 'vitest';
import { parseNote, serializeNote, taskContractHash, validateNote } from '../src/index.js';

const uri = 'note://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source = ['---', 'schema: harness-note/1', 'id: 77777777-7777-4777-8777-777777777777',
  'kind: initiative', 'lifecycle: proposed', 'created: 2026-09-25', '---', '# Module',
  '## Goal', 'Compose modules.', '## Scope', 'Interfaces.', '## Acceptance criteria', '- [ ] AC-1: Resolve explicit ports.'].join('\n');

describe('S1.2 interface declarations', () => {
  it('round-trips provided, unbound and explicitly bound ports without altering contract hashing', () => {
    const note = parseNote(source);
    const before = taskContractHash(note);
    note.meta.interfaces = [{ name: 'IApi', direction: 'provides' }, { name: 'IStore', direction: 'needs' },
      { name: 'ILoader', direction: 'needs', provider: uri }];
    expect(validateNote(note)).toEqual([]);
    expect(parseNote(serializeNote(note)).meta.interfaces).toEqual(note.meta.interfaces);
    expect(taskContractHash(note)).toBe(before);
  });

  it.each([null, {}, 'IApi', [null], [42], [{ name: 'api', direction: 'needs' }],
    [{ name: 'IApi', direction: 'imports' }], [{ name: 'IApi', direction: 'needs', provider: null }],
    [{ name: 'IApi', direction: 'needs', provider: 'relative.md' }],
    [{ name: 'IApi', direction: 'needs', version: 'v1' }],
    [{ name: 'IApi', direction: 'needs' }, { name: 'IApi', direction: 'needs', provider: uri }],
  ])('rejects invalid declaration without throwing: %j', (interfaces) => {
    const note = parseNote(source);
    Object.assign(note.meta, { interfaces });
    expect(validateNote(note)).toContainEqual(expect.objectContaining({ code: 'SCHEMA_INVALID' }));
  });

  it('rejects the field on non-initiative Notes even when empty', () => {
    const note = parseNote(source);
    note.meta.kind = 'idea';
    note.meta.interfaces = [];
    expect(validateNote(note)).toContainEqual(expect.objectContaining({ message: 'interfaces only for initiative' }));
  });
});
