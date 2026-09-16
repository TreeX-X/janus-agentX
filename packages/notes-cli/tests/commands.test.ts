/** CLI command surface over tmp repos: create/list/show/check/apply. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdApply, cmdCheck, cmdCreate, cmdList, cmdShow, exitFor } from '../src/index.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'notes-cli-'));
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.json'),
    JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 't', profile: { id: 'workflowx', version: '1.0.0-s1', digest: 'x' } }),
  );
  return root;
}

const REQ_SECTIONS = {
  Problem: 'P.',
  'Expected behavior': 'E.',
  Scope: 'S.',
  'Acceptance criteria': '- [ ] AC-1: One.',
};

describe('commands', () => {
  it('creates, lists, shows, and checks a requirement', async () => {
    const root = makeRepo();
    const created = await cmdCreate(root, { kind: 'requirement', title: 'T', sections: REQ_SECTIONS, lifecycle: 'proposed' });
    expect(created.ok).toBe(true);
    const listed = await cmdList(root, {});
    expect(listed.data?.notes).toHaveLength(1);
    expect(listed.data?.notes[0].uri).toContain(REPO);
    const shown = await cmdShow(root, created.data?.id ?? '');
    expect(shown.ok).toBe(true);
    expect(shown.data?.sha256).toHaveLength(64);
    const checked = await cmdCheck(root);
    expect(checked.ok).toBe(true);
    expect(exitFor(checked.errors)).toBe(0);
  });
  it('applies a replace once, then reports the stale retry as conflict', async () => {
    const root = makeRepo();
    const created = await cmdCreate(root, { kind: 'requirement', title: 'T', sections: REQ_SECTIONS, lifecycle: 'proposed' });
    const id = created.data?.id ?? '';
    const shown = await cmdShow(root, id);
    const uri = `note://${REPO}/${id}`;
    const csFile = join(root, 'cs.json');
    writeFileSync(
      csFile,
      JSON.stringify({
        id: 'cs-1',
        revision: 1,
        source: { type: 'manual', id: 'm', revision: 1 },
        operations: [
          {
            operationId: 'r-1',
            type: 'replace',
            uri,
            expectedHash: shown.data?.sha256,
            afterMarkdown: (shown.data?.text ?? '').replace('P.', 'P new.'),
            dependsOn: [],
            reason: 't',
            evidenceRefs: [],
          },
        ],
      }),
    );
    const first = await cmdApply(root, csFile, {});
    expect(first.ok).toBe(true);
    const second = await cmdApply(root, csFile, {});
    expect(second.ok).toBe(true); // identical file digest replays the stored outcome
    const staleFile = join(root, 'cs-stale.json');
    writeFileSync(
      staleFile,
      JSON.stringify({
        id: 'cs-9',
        revision: 1,
        source: { type: 'manual', id: 'm', revision: 1 },
        operations: [
          {
            operationId: 'r-9',
            type: 'replace',
            uri,
            expectedHash: shown.data?.sha256,
            afterMarkdown: (shown.data?.text ?? '').replace('P.', 'P stale.'),
            dependsOn: [],
            reason: 't',
            evidenceRefs: [],
          },
        ],
      }),
    );
    const stale = await cmdApply(root, staleFile, {});
    expect(stale.ok).toBe(false);
    expect(exitFor(stale.errors)).toBe(3);
  });
  it('flags broken files with exit 2', async () => {
    const root = makeRepo();
    mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
    writeFileSync(join(root, '.agents', 'notes', 'bad.md'), 'no frontmatter\n');
    const checked = await cmdCheck(root);
    expect(checked.ok).toBe(false);
    expect(exitFor(checked.errors)).toBe(2);
    const missing = await cmdShow(root, 'nope');
    expect(missing.ok).toBe(false);
    expect(exitFor(missing.errors)).toBe(2);
  });
});
