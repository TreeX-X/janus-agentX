/** F03: one winner per expectedHash, losers keep bytes, retries stay idempotent. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyChangeSet, buildNoteIndex, sha256HexBytes } from '../src/index.js';
import { applyChangeSet, buildNoteIndex, sha256HexBytes } from '../src/index.js';
import { REPO, makeRepo, requirementNote, writeNote } from './helpers.js';

const uri = (id: string): string => `note://${REPO}/${id}`;
const ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const op = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({
    operationId: 'op-1',
    type: 'create',
    uri: uri(ID),
    expectedHash: null,
    afterMarkdown: requirementNote(ID),
    dependsOn: [],
    noteDiagnostics: [],
    ...over,
  }) as never;

describe('transaction conflicts', () => {
  it('applies a create and indexes it', async () => {
    const root = makeRepo();
    const report = await applyChangeSet(root, { id: 'cs-1', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [op()] }, { requestDigest: 'd1' });
    expect(report.ok).toBe(true);
    const index = await buildNoteIndex(root);
    expect(index.byId.has(ID)).toBe(true);
  });
  it('lets exactly one writer win on the same expectedHash (F03)', async () => {
    const root = makeRepo();
    const rel = writeNote(root, '2026-09-16-t--aaaaaaaa.md', requirementNote(ID));
    const base = sha256HexBytes(readFileSync(join(root, rel)));
    const replace = (suffix: string, n: number): Record<string, unknown> =>
      ({
        operationId: `op-${n}`,
        type: 'replace',
        uri: uri(ID),
        expectedHash: base,
        afterMarkdown: requirementNote(ID).replace('P.', `P ${suffix}.`),
        dependsOn: [],
        noteDiagnostics: [],
      }) as never;
    const a = await applyChangeSet(root, { id: 'cs-a', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [replace('A', 1)] }, { requestDigest: 'da' });
    expect(a.ok).toBe(true);
    const b = await applyChangeSet(root, { id: 'cs-b', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [replace('B', 1)] }, { requestDigest: 'db' });
    expect(b.ok).toBe(false);
    expect(b.errors.some((e) => e.code === 'CONFLICT')).toBe(true);
    expect(readFileSync(join(root, rel), 'utf8')).toContain('P A.');
  });
  it('replays the same request digest without duplicating', async () => {
    const root = makeRepo();
    const cs = { id: 'cs-r', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [op()] };
    const first = await applyChangeSet(root, cs, { requestDigest: 'same' });
    const second = await applyChangeSet(root, cs, { requestDigest: 'same' });
    expect(first.ok && second.ok).toBe(true);
    const index = await buildNoteIndex(root);
    expect(index.entries.filter((e) => e.note?.meta.id === ID)).toHaveLength(1);
  });
  it('rejects the same key with a different digest', async () => {
    const root = makeRepo();
    const cs = { id: 'cs-k', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [op()] };
    await applyChangeSet(root, cs, { requestDigest: 'one' });
    const retry = await applyChangeSet(root, cs, { requestDigest: 'two' });
    expect(retry.ok).toBe(false);
  });
  it('gates deletes behind an explicit grant', async () => {
    const root = makeRepo();
    const rel = writeNote(root, '2026-09-16-t--aaaaaaaa.md', requirementNote(ID));
    const base = sha256HexBytes(readFileSync(join(root, rel)));
    const del = {
      operationId: 'del-1',
      type: 'delete',
      uri: uri(ID),
      expectedHash: base,
      dependsOn: [],
      noteDiagnostics: [],
    } as never;
    const denied = await applyChangeSet(root, { id: 'cs-d', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [del] }, { requestDigest: 'dd' });
    expect(denied.errors.some((e) => e.code === 'APPROVAL_REQUIRED')).toBe(true);
    const allowed = await applyChangeSet(
      root,
      { id: 'cs-d', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [del] },
      { requestDigest: 'dd', allowDelete: true },
    );
    expect(allowed.ok).toBe(true);
  });
  it('writes nothing when the post-image closes a loop', async () => {
    const root = makeRepo();
    const bId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const aNote = requirementNote(ID).replace('lifecycle: proposed', 'lifecycle: accepted');
    const mkCreate = (n: number, text: string, id: string): Record<string, unknown> =>
      ({ operationId: `c-${n}`, type: 'create', uri: uri(id), expectedHash: null, afterMarkdown: text, dependsOn: [], noteDiagnostics: [] }) as never;
    const withParent = (text: string, parentId: string): string =>
      text.replace('created: 2026-09-16', `created: 2026-09-16\nparent: ${uri(parentId)}`);
    const report = await applyChangeSet(
      root,
      { id: 'cs-loop', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [mkCreate(1, withParent(aNote, bId), ID), mkCreate(2, withParent(aNote, ID), bId)] },
      { requestDigest: 'loop' },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'INVALID_RELATION')).toBe(true);
    expect((await buildNoteIndex(root)).entries).toHaveLength(0);
  });
});
