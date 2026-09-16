/** Tmp-repo helper shared by harness-node suites (not a test itself). */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';

export function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-'));
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.json'),
    JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 't', profile: { id: 'workflowx', version: '1.0.0-s1', digest: 'x' } }),
  );
  return root;
}

export const REQ_ID = '33333333-3333-4333-8333-333333333333';

export function requirementNote(id = REQ_ID): string {
  return [
    '---',
    'schema: harness-note/1',
    `id: ${id}`,
    'kind: requirement',
    'lifecycle: proposed',
    'created: 2026-09-16',
    '---',
    '',
    '# T',
    '',
    '## Problem',
    '',
    'P.',
    '',
    '## Expected behavior',
    '',
    'E.',
    '',
    '## Scope',
    '',
    'S.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] AC-1: One.',
    '',
  ].join('\n');
}

export function writeNote(root: string, name: string, text: string): string {
  const rel = `.agents/notes/${name}`;
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(join(root, rel), text);
  return rel;
}
