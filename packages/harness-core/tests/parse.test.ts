/** F01 single-file rules: sections, relations, paths, execution guards. */
import { describe, expect, it } from 'vitest';
import { parseNote, validateNote } from '../src/index.js';

const head = (id: string, kind: string, lifecycle: string, extra = ''): string =>
  [
    '---',
    'schema: harness-note/1',
    `id: ${id}`,
    `kind: ${kind}`,
    `lifecycle: ${lifecycle}`,
    'created: 2026-09-16',
    extra,
    '---',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';

const codesOf = (raw: string): string[] => {
  try {
    return validateNote(parseNote(raw)).map((d) => d.code);
  } catch (e) {
    return [(e as { code?: string }).code ?? '?'];
  }
};

describe('parse + validate', () => {
  it('accepts a minimal draft idea', () => {
    const raw = head('11111111-1111-4111-8111-111111111111', 'idea', 'draft') + '# T\n\n## Background\n\nWhy.\n';
    expect(validateNote(parseNote(raw))).toEqual([]);
  });
  it('rejects unknown top-level keys', () => {
    const raw =
      head('11111111-1111-4111-8111-111111111112', 'idea', 'draft', 'unknownField: boom') +
      '# T\n\n## Background\n\nWhy.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects duplicate YAML keys', () => {
    const raw =
      '---\nschema: harness-note/1\nid: 11111111-1111-4111-8111-111111111113\nkind: idea\nlifecycle: draft\ncreated: 2026-09-16\ncreated: 2026-09-17\n---\n\n# T\n\n## Background\n\nWhy.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects custom tags and anchors', () => {
    const raw =
      head('11111111-1111-4111-8111-111111111114', 'idea', 'draft', 'tags: !foo [a]') +
      '# T\n\n## Background\n\nWhy.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects a missing H1', () => {
    const raw = head('11111111-1111-4111-8111-111111111115', 'idea', 'draft') + '## Background\n\nWhy.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects duplicate AC ids', () => {
    const raw =
      head('33333333-3333-4333-8333-333333333331', 'requirement', 'proposed') +
      '# T\n\n## Problem\n\nP.\n\n## Expected behavior\n\nE.\n\n## Scope\n\nS.\n\n## Acceptance criteria\n\n- [ ] AC-1: One.\n- [ ] AC-1: Two.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects implements from a non-task', () => {
    const raw =
      head(
        '11111111-1111-4111-8111-111111111116',
        'idea',
        'proposed',
        'relations:\n  - type: implements\n    target: note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/33333333-3333-4333-8333-333333333333\n    criteria: [AC-1]',
      ) + '# T\n\n## Background\n\nB.\n\n## Idea\n\nI.\n\n## Open questions\n\nNone.\n';
    expect(codesOf(raw)).toContain('INVALID_RELATION');
  });
  it('rejects escaping codeRef paths', () => {
    const raw =
      head(
        '33333333-3333-4333-8333-333333333332',
        'requirement',
        'proposed',
        'codeRefs:\n  - repoId: 8fa19f17-c717-43a8-93a7-810a5e0cbc91\n    path: ../escape.txt\n    role: implementation',
      ) + '# T\n\n## Problem\n\nP.\n\n## Expected behavior\n\nE.\n\n## Scope\n\nS.\n\n## Acceptance criteria\n\n- [ ] AC-1: One.\n';
    expect(codesOf(raw)).toContain('SCHEMA_INVALID');
  });
  it('rejects execution on drafts and requires work for accepted tasks', () => {
    const draft =
      head('55555555-5555-4555-8555-555555555551', 'task', 'draft', 'execution:\n  mode: xdo') +
      '# T\n\n## Scope\n\nS.\n';
    expect(codesOf(draft)).toContain('SCHEMA_INVALID');
    const noWork =
      head('55555555-5555-4555-8555-555555555552', 'task', 'accepted') +
      '# T\n\n## Scope\n\nS.\n\n## Acceptance criteria\n\n- [ ] AC-1: One.\n\n## Verification\n\nV.\n';
    expect(codesOf(noWork)).toContain('NOT_READY');
  });
  it('ignores headings inside fenced code', () => {
    const raw =
      head('11111111-1111-4111-8111-111111111117', 'idea', 'draft') +
      '# T\n\n## Background\n\n```md\n# not a title\n```\n\nText.\n';
    const note = parseNote(raw);
    expect(note.title).toBe('T');
    expect(validateNote(note)).toEqual([]);
  });
});
