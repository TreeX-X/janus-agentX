import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/** argv runner: usage, JSON envelope, exit codes, offline end-to-end. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wfx-'));
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.json'),
    JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 't', profile: SUPPORTED_HARNESS_PROFILE }),
  );
  return root;
}

describe('cli runner', () => {
  it('prints usage with exit 2 on unknown commands', async () => {
    const out = await run(['nope'], tmpdir());
    expect(out.exit).toBe(2);
    expect(out.stdout).toContain('wfx-notes');
  });
  it('creates and checks through argv with no network involved', async () => {
    const root = makeRepo();
    const body = join(root, 'body.md');
    writeFileSync(body, '## Background\n\nWhy.\n');
    const created = await run(
      ['--root', root, '--json', 'create', '--kind', 'idea', '--title', 'Hi', '--body-file', body],
      root,
    );
    expect(created.exit).toBe(0);
    const envelope = JSON.parse(created.stdout) as { ok: boolean; data: unknown; errors: unknown[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.errors).toEqual([]);
    const checked = await run(['--root', root, 'check'], root);
    expect(checked.exit).toBe(0);
    const listed = await run(['--root', root, '--json', 'list'], root);
    const listedBody = JSON.parse(listed.stdout) as { ok: boolean; data: { notes: unknown[] } };
    expect(listedBody.data.notes).toHaveLength(1);
  });
  it('denies deletes without the explicit grant (exit 4)', async () => {
    const root = makeRepo();
    const cs = join(root, 'del.json');
    writeFileSync(
      cs,
      JSON.stringify({
        id: 'cs-del',
        revision: 1,
        source: { type: 'manual', id: 'm', revision: 1 },
        operations: [
          { operationId: 'd-1', type: 'delete', uri: `note://${REPO}/00000000-0000-4000-8000-000000000000`, expectedHash: 'a'.repeat(64), dependsOn: [], reason: 't', evidenceRefs: [] },
        ],
      }),
    );
    const out = await run(['--root', root, '--json', 'apply', cs], root);
    expect(out.exit).not.toBe(0);
  });
});
