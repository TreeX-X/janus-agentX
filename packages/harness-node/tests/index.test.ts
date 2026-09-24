import { describe, expect, it } from 'vitest';
import { buildNoteIndex, queryNoteIndex, searchNoteIndex } from '../src/index.js';
import { makeRepo, REPO, writeNote } from './helpers.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function requirement(id: string, title: string, extra = ''): string {
  return [
    '---',
    'schema: harness-note/1',
    `id: ${id}`,
    'kind: requirement',
    'lifecycle: proposed',
    'created: 2026-09-24',
    'class: feature',
    extra,
    '---',
    '',
    `# ${title}`,
    '',
    '## Problem',
    '',
    `${title} problem.`,
    '',
    '## Expected behavior',
    '',
    `${title} behavior.`,
    '',
    '## Scope',
    '',
    'The scoped change.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] AC-1: The behavior is observable.',
    '',
  ].join('\n');
}

describe('derived note index', () => {
  it('keeps URI lookup, outgoing edges, and backlinks in one scan', async () => {
    const root = makeRepo();
    writeNote(
      root,
      'a.md',
      requirement(
        A,
        'Alpha search behavior',
        `codeRefs:\n  - repoId: ${REPO}\n    path: src/search.ts\n    symbol: searchNotes\n    role: implementation\nrelations:\n  - type: related-to\n    target: note://${REPO}/${B}`,
      ),
    );
    writeNote(root, 'b.md', requirement(B, 'Beta target'));

    const index = await buildNoteIndex(root);
    const aUri = `note://${REPO}/${A}`;
    const bUri = `note://${REPO}/${B}`;
    expect(index.byUri.get(aUri)?.note?.title).toBe('Alpha search behavior');
    expect(index.outgoing.get(aUri)).toMatchObject([
      { sourceUri: aUri, targetUri: bUri, type: 'related-to', declarations: ['relations[0]'], resolution: { status: 'resolved' } },
    ]);
    expect(index.relations).toMatchObject([
      { sourceUri: aUri, targetUri: bUri, type: 'related-to' },
    ]);
    expect(index.backlinks.get(bUri)).toEqual([{ sourceUri: aUri, type: 'related-to' }]);
    expect(queryNoteIndex(index, { relationType: 'related-to' }).map((entry) => entry.note?.meta.id)).toEqual([A, B]);
    expect(queryNoteIndex(index, { codePath: 'src/search' }).map((entry) => entry.note?.meta.id)).toEqual([A]);
  });

  it('searches body and metadata without adding a search database', async () => {
    const root = makeRepo();
    writeNote(root, 'a.md', requirement(A, 'Alpha search behavior'));
    writeNote(root, 'b.md', requirement(B, 'Beta target'));

    const index = await buildNoteIndex(root);
    const hits = searchNoteIndex(index, 'search behavior');
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.note?.meta.id).toBe(A);
    expect(hits[0].fields).toContain('title');
    expect(searchNoteIndex(index, 'missing')).toEqual([]);
  });

  it('keeps invalid notes visible for diagnostics but out of semantic graph queries', async () => {
    const root = makeRepo();
    writeNote(root, 'invalid.md', requirement(A, 'Invalid target', 'parent: not-a-note-uri'));
    const index = await buildNoteIndex(root);
    expect(index.byId.get(A)?.diagnostics.length).toBeGreaterThan(0);
    expect(index.byUri.has(`note://${REPO}/${A}`)).toBe(false);
    expect(index.relations).toEqual([]);
    expect(queryNoteIndex(index)).toEqual([]);
  });
});
