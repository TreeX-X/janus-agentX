import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyChangeSet, buildNoteIndex, claimsHarnessSchema, commitAssetFiles, SUPPORTED_HARNESS_PROFILE } from '../src/index.js';
import { makeRepo, REPO, REQ_ID, requirementNote, writeNote } from './helpers.js';

describe('shared profile and namespace', () => {
  it.runIf(existsSync(new URL('../../../../WorkFlowX/standards/harness-note/1/manifest.json', import.meta.url)))('pins the actual standard manifest rather than trusting a consumer digest', () => {
    const text = readFileSync(new URL('../../../../WorkFlowX/standards/harness-note/1/manifest.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(JSON.parse(text).version).toBe(SUPPORTED_HARNESS_PROFILE.version);
    expect(createHash('sha256').update(text).digest('hex')).toBe(SUPPORTED_HARNESS_PROFILE.digest);
  });

  it('separates foreign prose while diagnosing broken and future harness documents', async () => {
    const root = makeRepo();
    writeNote(root, 'legacy.md', '# Agent Note: Historic\n\nStatus: implemented\n');
    writeNote(root, 'valid.md', requirementNote());
    writeNote(root, 'future.md', requirementNote().replace('harness-note/1', 'harness-note/2'));
    writeNote(root, 'partial.md', '---\nschema: harness-note/1\nid: broken');
    const index = await buildNoteIndex(root);
    expect(index.entries.find((e) => e.foreign)).toMatchObject({ relPath: '.agents/notes/legacy.md', diagnostics: [] });
    expect(index.entries.find((e) => e.relPath.endsWith('future.md'))?.diagnostics[0].code).toBe('UNSUPPORTED_SCHEMA');
    expect(index.entries.find((e) => e.relPath.endsWith('partial.md'))?.diagnostics.length).toBeGreaterThan(0);
    expect(claimsHarnessSchema('\uFEFF---\r\n"schema": "harness-note/1"\r\n---')).toBe(true);
    expect(claimsHarnessSchema('---\nschema: another/1\n---')).toBe(false);
  });

  it.each([
    undefined,
    { ...SUPPORTED_HARNESS_PROFILE, version: '2.0.0' },
    { ...SUPPORTED_HARNESS_PROFILE, digest: '0'.repeat(64) },
  ])('keeps files readable and refuses every managed writer for an unsupported pin: %j', async (profile) => {
    const root = makeRepo();
    const rel = writeNote(root, 'existing.md', requirementNote());
    writeFileSync(join(root, '.agents/harness.json'), JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'T', profile }));
    const index = await buildNoteIndex(root);
    expect(index.byId.get(REQ_ID)?.note?.title).toBe('T');
    expect(index.diagnostics[0].code).toBe('UNSUPPORTED_SCHEMA');
    const result = await applyChangeSet(root, {
      id: 'profile-refusal', revision: 1, source: { type: 'manual', id: 't', revision: 1 },
      operations: [{ operationId: 'one', type: 'replace', uri: `note://${REPO}/${REQ_ID}`, expectedHash: index.byId.get(REQ_ID)!.sha256,
        afterMarkdown: requirementNote().replace('P.', 'Changed.'), dependsOn: [], noteDiagnostics: [] }],
    }, { requestDigest: 'replace' });
    expect(result.errors[0].code).toBe('UNSUPPORTED_SCHEMA');
    await expect(commitAssetFiles(root, [{ path: rel, before: index.byId.get(REQ_ID)!.sha256, after: 'changed' }])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
    expect(readFileSync(join(root, rel), 'utf8')).toBe(requirementNote());
  });
});
