import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { buildNoteIndex, queryNoteIndex, readIndexedNote, resolveNoteReference, searchNoteIndex } from '../src/index.js';
import { makeRepo, REPO, requirementNote, writeNote } from './helpers.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const uri = (id: string, repo = REPO) => 'note://' + repo + '/' + id;
const withMeta = (id: string, extra: string) => requirementNote(id).replace('created: 2026-09-16', 'created: 2026-09-16\n' + extra);
afterEach(() => vi.restoreAllMocks());

describe('shared Note read boundary', () => {
  it('diagnoses every duplicate before publishing lookups, queries or navigation', async () => {
    const root = makeRepo();
    writeNote(root, 'a.md', requirementNote(A));
    writeNote(root, 'copy.md', requirementNote(A));
    writeNote(root, 'b.md', withMeta(B, 'relations:\n  - type: related-to\n    target: ' + uri(A)) + '\n[ambiguous](' + uri(A) + ')');
    const index = await buildNoteIndex(root);
    expect(index.conflicts.get(A)).toHaveLength(2);
    for (const entry of index.conflicts.get(A)!) {
      expect(entry.classification).toBe('conflicting-identity');
      expect(entry.diagnostics.some((d) => d.message.includes('duplicate'))).toBe(true);
    }
    expect(index.byId.has(A)).toBe(false);
    expect(index.byUri.has(uri(A))).toBe(false);
    expect(queryNoteIndex(index).map((entry) => entry.note!.meta.id)).toEqual([B]);
    expect(searchNoteIndex(index, 'T').map((hit) => hit.entry.note!.meta.id)).toEqual([B]);
    expect(index.outgoing.has(uri(A))).toBe(false);
    expect(index.relations[0].resolution.status).toBe('ambiguous');
    expect(index.mentions[0].resolution.status).toBe('ambiguous');
    expect(index.mentionBacklinks.has(uri(A))).toBe(false);
  });

  it('separates mentions from formal edges and preserves unresolved locators', async () => {
    const root = makeRepo();
    writeNote(root, 'b.md', requirementNote(B));
    writeNote(root, 'ordinary.md', '# Ordinary document');
    const prose = [
      '[relative](./b.md#scope) [direct](' + uri(B) + '#scope) [reference][B]',
      '', '[B]: ' + uri(B) + '#scope', '',
      '[self](#scope) [section](b.md#absent) [missing](gone.md)',
      '[remote](' + uri(C, C) + ') [invalid](note://bad)',
      '[ordinary](ordinary.md) [web](https://example.com) [readme](../../README.md)',
      '[ordinary invalid locator](%zz.png)',
      '[bad fragment](' + uri(B) + '#%zz)',
    ].join('\n');
    const declarations = [
      'parent: ' + uri(B), 'relations:',
      '  - type: governed-by', '    target: ' + uri(B),
      '  - type: implements', '    target: ' + uri(B), '    criteria: [AC-1]',
      '  - type: supersedes', '    target: ' + uri(B), '    scope: partial', '    reason: Shared contract',
      ...['depends-on', 'derived-from', 'related-to'].flatMap((type) => ['  - type: ' + type, '    target: ' + uri(B)]),
    ].join('\n');
    writeNote(root, 'a.md', withMeta(A, declarations).replace('kind: requirement', 'kind: task').replace('lifecycle: proposed', 'lifecycle: draft') + prose);
    const index = await buildNoteIndex(root);
    expect(index.byId.get(A)?.diagnostics).toEqual([]);
    const mention = index.mentions.find((m) => m.targetUri === uri(B) && m.anchor === 'scope')!;
    expect(mention.occurrences).toHaveLength(3);
    expect(mention.destinations).toEqual(['./b.md#scope', uri(B) + '#scope']);
    expect(mention.resolution).toMatchObject({ status: 'resolved', anchorStatus: 'resolved' });
    expect(index.mentions.find((m) => m.anchor === 'absent')).toMatchObject({ targetUri: uri(B), resolution: { status: 'resolved', anchorStatus: 'missing' } });
    expect(index.mentions.find((m) => m.anchor === '%zz')?.resolution).toMatchObject({ status: 'resolved', anchorStatus: 'invalid' });
    expect(index.mentions.find((m) => m.targetUri === uri(A))?.resolution.status).toBe('resolved');
    expect(index.mentions.find((m) => m.destinations.includes('gone.md'))?.resolution.status).toBe('missing');
    expect(index.mentions.find((m) => m.targetUri === uri(C, C))?.resolution).toMatchObject({ status: 'unavailable', reason: 'unbound-repository' });
    expect(index.mentionBacklinks.get(uri(C, C))).toMatchObject([{ resolution: { status: 'unavailable' } }]);
    expect(index.mentions.find((m) => m.targetUri === 'note://bad')?.resolution.status).toBe('invalid');
    expect(index.mentions).toHaveLength(7);
    expect(index.relations.map((edge) => edge.type).sort()).toEqual(['depends-on', 'derived-from', 'governed-by', 'implements', 'parent', 'related-to', 'supersedes']);
    expect(index.relations.find((edge) => edge.type === 'supersedes')).toMatchObject({ scope: 'partial', reason: 'Shared contract' });
    expect(index.backlinks.get(uri(B))?.find((edge) => edge.type === 'implements')).toMatchObject({ criteria: ['AC-1'] });
    expect(index.mentionBacklinks.get(uri(B))).toHaveLength(3);
    expect(index.diagnostics).toEqual([]);
    expect(index.readDiagnostics.length).toBeGreaterThan(0);
  });

  it('deduplicates equivalent parent declarations and diagnoses parent cycles', async () => {
    const root = makeRepo();
    writeNote(root, 'a.md', withMeta(A, 'parent: ' + uri(B) + '\nrelations:\n  - type: parent\n    target: ' + uri(B)));
    writeNote(root, 'b.md', withMeta(B, 'parent: ' + uri(A)));
    const index = await buildNoteIndex(root);
    expect(index.outgoing.get(uri(A))).toHaveLength(1);
    expect(index.outgoing.get(uri(A))![0].declarations).toEqual(['parent', 'relations[0]']);
    expect(index.backlinks.get(uri(B))).toHaveLength(1);
    expect(index.readDiagnostics.some((d) => /cycle/i.test(d.message))).toBe(true);
  });

  it('keeps selected worktrees separate and rebuilds deterministically', async () => {
    const a = makeRepo();
    const b = makeRepo();
    writeNote(a, 'a.md', requirementNote(A));
    writeNote(b, 'b.md', requirementNote(A).replace('# T', '# Other checkout'));
    const first = await buildNoteIndex(a);
    const second = await buildNoteIndex(b);
    expect(first.byUri.get(uri(A))?.note?.title).toBe('T');
    expect(second.byUri.get(uri(A))?.note?.title).toBe('Other checkout');
    expect(first.coverage.checkoutRoot).not.toBe(second.coverage.checkoutRoot);
    expect(first.coverage.snapshotHash).not.toBe(second.coverage.snapshotHash);
    const again = await buildNoteIndex(a);
    expect(again.coverage).toEqual(first.coverage);
    expect(again.entries).toEqual(first.entries);
    expect(again.relations).toEqual(first.relations);
  });

  it('returns raw-byte hashes and reports changed lazy reads without relabeling content', async () => {
    const root = makeRepo();
    const original = requirementNote(A);
    const rel = writeNote(root, 'a.md', original);
    const index = await buildNoteIndex(root);
    const expected = createHash('sha256').update(Buffer.from(original)).digest('hex');
    expect(index.byId.get(A)?.sourceHash).toBe(expected);
    expect(await readIndexedNote(index, rel)).toMatchObject({ ok: true, text: original, sourceHash: expected, matchesSnapshot: true });
    const changed = '\uFEFF' + original.replace(/\n/g, '\r\n');
    writeFileSync(join(root, rel), changed);
    const actual = createHash('sha256').update(Buffer.from(changed)).digest('hex');
    expect(actual).not.toBe(expected);
    expect(await readIndexedNote(index, rel)).toMatchObject({ ok: true, text: changed, sourceHash: actual, sha256: actual, indexedSourceHash: expected, matchesSnapshot: false });
    renameSync(join(root, rel), join(root, '.agents/notes/renamed.md'));
    expect((await buildNoteIndex(root)).byUri.get(uri(A))?.sourceHash).toBe(actual);
    expect(await readIndexedNote(index, rel)).toMatchObject({ ok: false, diagnostics: [{ code: 'IO_ERROR' }] });
    expect(await readIndexedNote(index, '../outside.md')).toMatchObject({ ok: false });
  });

  it('classifies unmanaged files and invalid targets without discarding them', async () => {
    const root = makeRepo();
    writeNote(root, 'legacy.md', '# Agent Note: Earlier design\n\nStatus: implemented');
    writeNote(root, 'foreign.md', '# Other page');
    writeNote(root, 'broken.md', '---\nschema: harness-note/1\nid: broken');
    writeNote(root, 'invalid.md', withMeta(A, 'parent: broken'));
    writeNote(root, 'valid.md', requirementNote(B));
    const index = await buildNoteIndex(root);
    expect(index.entries.map((e) => e.classification)).toEqual(['malformed', 'foreign', 'malformed', 'legacy', 'valid']);
    expect(resolveNoteReference(index, uri(A)).status).toBe('invalid');
    expect(index.byPath.get('.agents/notes/legacy.md')?.view?.headings[0].text).toBe('Agent Note: Earlier design');
    expect(index.coverage.status).toBe('complete');
  });

  it('reports incomplete coverage for unreadable files instead of declaring absence', async () => {
    const root = makeRepo();
    const rel = writeNote(root, 'unreadable.md', requirementNote(A));
    const read = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === join(root, rel)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      return read(...args);
    });
    const index = await buildNoteIndex(root);
    expect(index.coverage.status).toBe('incomplete');
    expect(index.byPath.get(rel)).toMatchObject({ classification: 'unreadable', sourceHash: null });
    expect(resolveNoteReference(index, uri(A))).toMatchObject({ status: 'unavailable', reason: 'incomplete-scan' });
  });

  it('distinguishes absent notes directory from failed directory enumeration', async () => {
    const root = makeRepo();
    rmSync(join(root, '.agents/notes'), { recursive: true });
    const empty = await buildNoteIndex(root);
    expect(empty.coverage.status).toBe('complete');
    expect(resolveNoteReference(empty, uri(A)).status).toBe('missing');
    mkdirSync(join(root, '.agents/notes'));
    vi.spyOn(fs, 'readdir').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const failed = await buildNoteIndex(root);
    expect(failed.coverage.status).toBe('incomplete');
    expect(resolveNoteReference(failed, uri(A)).status).toBe('unavailable');
  });

  it('bounds symlink cycles and refuses escaping directory links', async () => {
    const root = makeRepo();
    symlinkSync(join(root, '.agents/notes'), join(root, '.agents/notes/cycle'), 'junction');
    symlinkSync(makeRepo(), join(root, '.agents/notes/escape'), 'junction');
    const index = await buildNoteIndex(root);
    expect(index.coverage.status).toBe('incomplete');
    expect(index.coverage.diagnostics).toHaveLength(2);
    expect(index.entries).toEqual([]);
  });
});
