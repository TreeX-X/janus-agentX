// Note: all hosts use the same namespace and profile gate — see .agents/notes/harness/storage/history/harness-profile-namespace.md
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '@janus-agent/harness-core';

/** Pinned to the LF-normalized WorkFlowX standard manifest, never to a checkout path. */
export const LEGACY_HARNESS_PROFILE = Object.freeze({
  id: 'workflowx',
  version: '1.0.0-s1.2',
  digest: '1b9500b1ea5101231650f04f2e5e2c480001ccf9512ec173b8e5d737bf2d6923',
});

export const SUPPORTED_HARNESS_PROFILE = Object.freeze({id: 'workflowx', version: '2.0.0', digest: 'b76f1d5e98fce7a8fa56f5f60b023b457640e7036c32096e430a8481ef83c5e8'});
export const SUPPORTED_HARNESS_PROFILES = [SUPPORTED_HARNESS_PROFILE, LEGACY_HARNESS_PROFILE];
export async function readHarnessIdentity(root: string): Promise<{ repoId: string | null; diagnostics: Diagnostic[]; profileKey?: string }> {
  const path = '.agents/harness.json';
  const fail = (code: Diagnostic['code'], message: string, repoId: string | null = null) => ({ repoId, diagnostics: [{ code, message, path }] });
  let raw: unknown;
  try { raw = JSON.parse((await readFile(join(root, path), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_READY' : 'SCHEMA_INVALID', 'A readable harness.json with a pinned profile is required for managed writes.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('SCHEMA_INVALID', 'harness.json must be an object.');
  const identity = raw as Record<string, unknown>;
  const repoId = typeof identity.repoId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identity.repoId) ? identity.repoId : null;
  if (!repoId || identity.schemaVersion !== 1 || typeof identity.name !== 'string' || !identity.name.trim()) {
    return fail('SCHEMA_INVALID', 'harness.json requires schemaVersion 1, a lowercase UUID repoId and a name.', repoId);
  }
  const profile = identity.profile as Record<string, unknown> | undefined;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
    !SUPPORTED_HARNESS_PROFILES.some(p => p.id === profile.id && p.version === profile.version && p.digest === profile.digest)) {
    return fail('UNSUPPORTED_SCHEMA', `Unsupported harness profile; this writer supports ${SUPPORTED_HARNESS_PROFILE.id} ${SUPPORTED_HARNESS_PROFILE.version} with digest ${SUPPORTED_HARNESS_PROFILE.digest}. Browse the files read-only or align the installed writer and pinned standard.`, repoId);
  }
  return { repoId, diagnostics: [], profileKey: JSON.stringify(profile) };
}

export async function assertWritableHarness(root: string): Promise<void> {
  const problem = (await readHarnessIdentity(root)).diagnostics[0];
  if (problem) throw Object.assign(new Error(problem.message), problem);
}

/** Unknown harness schema versions remain diagnostics; unrelated Markdown stays foreign. */
export function claimsHarnessSchema(raw: string): boolean {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/^---\s*\n/.test(text)) return false;
  const lines = text.split('\n').slice(1);
  const end = lines.findIndex((line) => /^---\s*$/.test(line));
  return (end < 0 ? lines : lines.slice(0, end)).some((line) => /(?:^|[,{])\s*(?:schema|'schema'|"schema")\s*:\s*['"]?harness-note\//.test(line));
}
