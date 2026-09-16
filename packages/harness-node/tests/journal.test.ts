/** F04: every journal stage survives a crash; foreign bytes park, never merge. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256HexBytes } from '../src/index.js';
import { isRecoveryRequired, readCommitted, recoverPending } from '../src/index.js';
import { applyChangeSet } from '../src/index.js';
import { REPO, makeRepo, requirementNote, writeNote } from './helpers.js';

const uri = (id: string): string => `note://${REPO}/${id}`;
const ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const createOp = (n: number, id = ID): Record<string, unknown> =>
  ({
    operationId: `c-${n}`,
    type: 'create',
    uri: uri(id),
    expectedHash: null,
    afterMarkdown: requirementNote(id),
    dependsOn: [],
    noteDiagnostics: [],
  }) as never;

describe('journal recovery', () => {
  it('drops a dead journal when the crash precedes all temp files', async () => {
    const root = makeRepo();
    const cs = { id: 'cs-j', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [createOp(1)] };
    const attempt = applyChangeSet(root, cs, { requestDigest: 'j1', inject: { failAfter: 'journal' } });
    await expect(attempt).rejects.toMatchObject({ code: 'IO_ERROR' });
    const report = await recoverPending(root);
    expect(report.resumed).toContain('cs-j-r1');
    expect(report.blocked).toHaveLength(0);
    // Nothing applied, so re-issuing the same change set lands cleanly.
    const retry = await applyChangeSet(root, cs, { requestDigest: 'j1' });
    expect(retry.ok).toBe(true);
    expect(await readCommitted(root, 'cs-j-r1')).not.toBeNull();
  });
  it('resumes after a crash past temp files and mid-ops', async () => {
    const root = makeRepo();
    const bId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    await expect(
      applyChangeSet(
        root,
        { id: 'cs-t', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [createOp(1), createOp(2, bId)] },
        { requestDigest: 't1', inject: { failAfter: 0 } },
      ),
    ).rejects.toMatchObject({ code: 'IO_ERROR' });
    const report = await recoverPending(root);
    expect(report.completed).toContain('cs-t-r1');
    const again = await applyChangeSet(
      root,
      { id: 'cs-t', revision: 1, source: { type: 'manual', id: 't', revision: 1 }, operations: [createOp(1), createOp(2, bId)] },
      { requestDigest: 't1' },
    );
    expect(again.ok).toBe(true);
  });
  it('parks on foreign bytes instead of overwriting them (neither)', async () => {
    const root = makeRepo();
    const rel = writeNote(root, '2026-09-16-t--aaaaaaaa.md', requirementNote(ID));
    const base = sha256HexBytes(readFileSync(join(root, rel)));
    const attempt = applyChangeSet(
      root,
      {
        id: 'cs-f',
        revision: 1,
        source: { type: 'manual', id: 't', revision: 1 },
        operations: [
          {
            operationId: 'r-1',
            type: 'replace',
            uri: uri(ID),
            expectedHash: base,
            afterMarkdown: requirementNote(ID).replace('P.', 'P managed.'),
            dependsOn: [],
            noteDiagnostics: [],
          } as never,
        ],
      },
      { requestDigest: 'f1', inject: { failAfter: 'temp' } },
    );
    await expect(attempt).rejects.toMatchObject({ code: 'IO_ERROR' });
    writeFileSync(join(root, rel), requirementNote(ID).replace('P.', 'P foreign.'));
    const report = await recoverPending(root);
    expect(report.blocked.map((b) => b.txId)).toContain('cs-f-r1');
    expect(await isRecoveryRequired(root, 'cs-f-r1')).not.toBeNull();
    expect(readFileSync(join(root, rel), 'utf8')).toContain('P foreign.');
    const retry = await applyChangeSet(
      root,
      {
        id: 'cs-f2',
        revision: 1,
        source: { type: 'manual', id: 't', revision: 1 },
        operations: [
          {
            operationId: 'r-1',
            type: 'replace',
            uri: uri(ID),
            expectedHash: base,
            afterMarkdown: requirementNote(ID).replace('P.', 'P managed.'),
            dependsOn: [],
            noteDiagnostics: [],
          } as never,
        ],
      },
      { requestDigest: 'f2' },
    );
    expect(retry.ok).toBe(false);
    expect(retry.errors.some((e) => e.code === 'RECOVERY_REQUIRED')).toBe(true);
  });
});
