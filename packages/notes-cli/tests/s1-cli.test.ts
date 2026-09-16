/** S1 bundle through the real CLI path: copied fixtures check clean. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cmdCheck, cmdList } from '../src/index.js';

const GIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const STD = join(GIT, 'WorkFlowX', 'standards', 'harness-note', '1', 'fixtures');
const PRESENT = existsSync(join(STD, 'valid-task.md'));

describe.runIf(PRESENT)('S1 fixtures via CLI', () => {
  it('checks the six valid fixtures clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 's1cli-'));
    mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'harness.json'),
      JSON.stringify({ schemaVersion: 1, repoId: '8fa19f17-c717-43a8-93a7-810a5e0cbc91', name: 't', profile: { id: 'workflowx', version: '1.0.0-s1', digest: 'x' } }),
    );
    for (const f of readdirSync(STD).filter((x) => x.startsWith('valid-') && x.endsWith('.md'))) {
      writeFileSync(join(root, '.agents', 'notes', f), readFileSync(join(STD, f)));
    }
    const checked = await cmdCheck(root);
    expect(checked.errors).toEqual([]);
    expect(checked.ok).toBe(true);
    const listed = await cmdList(root, {});
    expect(listed.data?.notes).toHaveLength(6);
  });
});
