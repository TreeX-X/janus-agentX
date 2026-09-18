/**
 * Git evidence primitives for closeout (contract C4, storage half).
 * Answers two questions against a checkout: does the worktree still match
 * a manifest, and which commits touch a pinned string in given paths.
 * Commit-content proof stays with the caller (S8 closeout); this module
 * only lists candidates honestly, never certifies landing.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256HexBytes } from './repository.js';

export interface GitRun {
  ok: boolean;
  stdout: string;
  error?: string;
}

export function runGit(cwd: string, args: string[]): GitRun {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
    if (r.error) return { ok: false, stdout: '', error: String(r.error) };
    if (r.status !== 0) return { ok: false, stdout: r.stdout ?? '', error: (r.stderr ?? '').trim() };
    return { ok: true, stdout: r.stdout ?? '' };
  } catch (e) {
    return { ok: false, stdout: '', error: String(e) };
  }
}

export function gitAvailable(cwd: string): boolean {
  return runGit(cwd, ['--version']).ok;
}

export function isGitRepo(cwd: string): boolean {
  const r = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export type ManifestEntry = { repoPath: string; sha256?: string; deleted?: boolean };

/** Every manifest row matches the worktree (or stays deleted). One mismatch fails the whole set. */
export async function worktreeMatches(repoRoot: string, manifest: ManifestEntry[]): Promise<{ ok: boolean; mismatched: string[] }> {
  const mismatched: string[] = [];
  for (const row of manifest) {
    if (row.deleted) {
      try {
        await readFile(resolve(repoRoot, row.repoPath));
        mismatched.push(row.repoPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') mismatched.push(row.repoPath);
      }
      continue;
    }
    try {
      const hash = sha256HexBytes(await readFile(resolve(repoRoot, row.repoPath)));
      if (row.sha256 && hash !== row.sha256) mismatched.push(row.repoPath);
    } catch {
      mismatched.push(row.repoPath);
    }
  }
  return { ok: mismatched.length === 0, mismatched };
}

/**
 * Commits whose diff touches `needle` inside `paths` (newest first).
 * Callers verify manifest content per candidate; absence of candidates
 * means "landed nowhere reachable", never "landed".
 */
export function findTouchingCommits(repoRoot: string, needle: string, paths: string[]): string[] {
  if (!needle || paths.length === 0) return [];
  const r = runGit(repoRoot, ['log', '--format=%H', `-S${needle}`, 'HEAD', '--', ...paths]);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** File content at a commit, null when absent there. */
export function showAt(repoRoot: string, sha: string, repoPath: string): string | null {
  const r = runGit(repoRoot, ['show', `${sha}:${repoPath}`]);
  return r.ok ? r.stdout : null;
}

export function landingCandidates(root: string, paths: string[]): string[] {
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return [];
  const history = runGit(root, ['log', '--format=%H', 'HEAD', '--', ...paths]);
  if (!history.ok) return [];
  return [...new Set([head.stdout.trim(), ...history.stdout.trim().split('\n')].filter(Boolean))];
}

/** Distinguish an absent Git entry from failed reads; binary bytes stay intact. */
export function gitFileAt(root: string, commit: string, path: string): { ok: true; bytes: Buffer | null } | { ok: false } {
  const tree = runGit(root, ['ls-tree', '-z', commit, '--', path]);
  if (!tree.ok) return { ok: false };
  if (!tree.stdout) return { ok: true, bytes: null };
  const entry = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(tree.stdout);
  if (!entry) return { ok: false };
  const result = spawnSync('git', ['cat-file', 'blob', entry[2]], { cwd: root, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 && !result.error ? { ok: true, bytes: result.stdout } : { ok: false };
}
