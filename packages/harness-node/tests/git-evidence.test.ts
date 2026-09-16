/** Git evidence against throwaway repos (skipped where git is absent). */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256HexBytes } from '../src/index.js';
import { findTouchingCommits, gitAvailable, runGit, showAt, worktreeMatches } from '../src/index.js';

const HAS_GIT = gitAvailable(tmpdir());

function git(cwd: string, args: string[]): void {
  const r = runGit(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.error}`);
}

describe.runIf(HAS_GIT)('git evidence', () => {
  it('matches manifests and finds landing commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ev-'));
    git(root, ['init']);
    git(root, ['config', 'user.email', 't@t']);
    git(root, ['config', 'user.name', 't']);
    writeFileSync(join(root, 'a.txt'), 'contract-abc\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'land']);
    const hash = sha256HexBytes(await readFile(join(root, 'a.txt')));
    expect((await worktreeMatches(root, [{ repoPath: 'a.txt', sha256: hash }])).ok).toBe(true);
    writeFileSync(join(root, 'a.txt'), 'drifted\n');
    expect(await worktreeMatches(root, [{ repoPath: 'a.txt', sha256: hash }])).toEqual({
      ok: false,
      mismatched: ['a.txt'],
    });
    const shas = findTouchingCommits(root, 'contract-abc', ['a.txt']);
    expect(shas).toHaveLength(1);
    expect(showAt(root, shas[0], 'a.txt')).toContain('contract-abc');
  });
});
