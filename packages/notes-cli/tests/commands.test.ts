import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/** CLI command surface over tmp repos: create/list/show/check/apply. */
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdApply, cmdCheck, cmdCreate, cmdList, cmdSearch, cmdShow, exitFor } from '../src/index.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'notes-cli-'));
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.json'),
    JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 't', profile: SUPPORTED_HARNESS_PROFILE }),
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
  it('reports foreign working notes without making check fail', async () => {
    const root = makeRepo();
    writeFileSync(join(root, '.agents/notes/working.md'), '# Agent Note: History\n\nStatus: implemented\n');
    expect(await cmdCheck(root)).toMatchObject({ ok: true, errors: [], data: { rows: [{ foreign: true, diagnostics: [] }] } });
    writeFileSync(join(root, '.agents/notes/future.md'), '---\nschema: harness-note/99\n---\n# Future\n');
    expect((await cmdCheck(root)).errors.some((e) => e.code === 'UNSUPPORTED_SCHEMA')).toBe(true);
  });
  it('creates, lists, shows, and checks a requirement', async () => {
    const root = makeRepo();
    const created = await cmdCreate(root, { kind: 'requirement', title: 'T', sections: REQ_SECTIONS, lifecycle: 'proposed' });
    expect(created.ok).toBe(true);
    const listed = await cmdList(root, {});
    expect(listed.data?.notes).toHaveLength(1);
    expect(listed.data?.notes[0].uri).toContain(REPO);
    expect(listed.data?.notes[0].excerpt).toContain('P.');
    expect(listed.data?.notes[0]).toMatchObject({ incoming: 0, outgoing: 0 });
    expect((await cmdList(root, { q: 'Expected behavior' })).data?.notes).toHaveLength(1);
    expect((await cmdSearch(root, 'One.')).data?.notes).toHaveLength(1);
    const shown = await cmdShow(root, created.data?.id ?? '');
    expect(shown.ok).toBe(true);
    expect(shown.data?.sha256).toHaveLength(64);
    const checked = await cmdCheck(root);
    expect(checked.ok).toBe(true);
    expect(exitFor(checked.errors)).toBe(0);
  });
  it('filters search results before applying the limit', async () => {
    const root = makeRepo();
    const seed = await cmdCreate(root, { kind: 'requirement', title: 'Match requirement 0', sections: REQ_SECTIONS, lifecycle: 'proposed' });
    const template = (await cmdShow(root, seed.data!.id)).data!.text;
    for (let i = 1; i < 21; i += 1) {
      const id = '11111111-1111-4111-8111-' + String(i).padStart(12, '0');
      writeFileSync(join(root, '.agents/notes/requirement-' + i + '.md'), template.replace(seed.data!.id, id).replace('Match requirement 0', 'Match requirement ' + i));
    }
    await cmdCreate(root, { kind: 'idea', title: 'Match idea', sections: { Background: 'P.', Idea: 'E.', 'Open questions': 'S.' }, lifecycle: 'draft' });
    const result = await cmdSearch(root, 'Match', { kind: 'idea', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.data?.notes).toHaveLength(1);
    expect(result.data?.notes[0].kind).toBe('idea');
    expect(result.data).toMatchObject({ limit: 1, truncated: false, coverage: { status: 'complete' } });
    expect((await cmdSearch(root, 'Match', { limit: 1 })).data?.truncated).toBe(true);
  });
  it('keeps broken prose references informational and visible through shared reads', async () => {
    const root = makeRepo();
    const first = await cmdCreate(root, { kind: 'requirement', title: 'Linked', sections: { ...REQ_SECTIONS, Scope: '[Missing](missing.md)' }, lifecycle: 'proposed' });
    expect(first.ok).toBe(true);
    expect((await cmdCreate(root, { kind: 'requirement', title: 'Next', sections: REQ_SECTIONS, lifecycle: 'proposed' })).ok).toBe(true);
    const shown = await cmdShow(root, first.data!.uri!);
    expect(shown.data).toMatchObject({ sourceHash: shown.data?.sha256, indexedSourceHash: shown.data?.sha256, matchesSnapshot: true });
    const checked = await cmdCheck(root);
    expect(checked.ok).toBe(true);
    expect(checked.data?.readDiagnostics.some((d) => d.message.includes('missing.md'))).toBe(true);
    writeFileSync(join(root, '.agents/notes/legacy.md'), '# Agent Note: History');
    const listed = await cmdList(root);
    expect(listed.data).toMatchObject({ coverage: { checkoutRoot: root, status: 'complete' }, excluded: [{ classification: 'legacy' }] });
  });
  it('never resolves an external URI or a duplicate identity to a local first match', async () => {
    const root = makeRepo();
    const created = await cmdCreate(root, { kind: 'requirement', title: 'T', sections: REQ_SECTIONS, lifecycle: 'proposed' });
    const shown = await cmdShow(root, created.data!.id);
    const external = 'note://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' + created.data!.id;
    expect(await cmdShow(root, external)).toMatchObject({ ok: false, errors: [{ code: 'NOT_READY' }] });
    writeFileSync(join(root, '.agents/notes/duplicate.md'), shown.data!.text);
    expect((await cmdShow(root, created.data!.id)).ok).toBe(false);
    expect((await cmdShow(root, created.data!.uri!)).ok).toBe(false);
    expect((await cmdShow(root, 'duplicate.md')).ok).toBe(false);
    const listed = await cmdList(root);
    expect(listed.data?.notes).toEqual([]);
    expect(listed.data?.excluded).toHaveLength(2);
  });
  it('requires a specific path when basenames collide', async () => {
    const root = makeRepo();
    for (const name of ['a', 'b']) {
      expect((await cmdCreate(root, { kind: 'requirement', title: name, sections: REQ_SECTIONS, lifecycle: 'proposed', relativePath: '.agents/notes/' + name + '/same.md' })).ok).toBe(true);
    }
    expect(await cmdShow(root, 'same.md')).toMatchObject({ ok: false, errors: [{ code: 'CONFLICT' }] });
    expect((await cmdShow(root, '.agents/notes/a/same.md')).ok).toBe(true);
  });
  it('does not infer a missing Note from a failed scan', async () => {
    const root = makeRepo();
    rmdirSync(join(root, '.agents/notes'));
    writeFileSync(join(root, '.agents/notes'), 'not a directory');
    expect(await cmdShow(root, 'unknown')).toMatchObject({ ok: false, errors: [{ code: 'NOT_READY' }] });
    expect((await cmdList(root)).data?.coverage.status).toBe('incomplete');
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
    writeFileSync(join(root, '.agents', 'notes', 'bad.md'), '---\nschema: harness-note/1\n---\n# Broken');
    const checked = await cmdCheck(root);
    expect(checked.ok).toBe(false);
    expect(exitFor(checked.errors)).toBe(2);
    const missing = await cmdShow(root, 'nope');
    expect(missing.ok).toBe(false);
    expect(exitFor(missing.errors)).toBe(2);
  });
});
