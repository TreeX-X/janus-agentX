import { SUPPORTED_HARNESS_PROFILE } from '@janus-agent/harness-node';
/**
 * `janus notes`: same operations as wfx-notes over the same command
 * functions; only argv parsing and the envelope live here. Temp
 * checkouts only, no model, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runNotes } from '../src/notes.js';

const REPO = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';

const IDEA_MD = [
  '---',
  'schema: harness-note/1',
  'id: 11111111-1111-4111-8111-111111111111',
  'kind: idea',
  'lifecycle: draft',
  'created: 2026-09-17',
  '---',
  '',
  '# Fast builds',
  '',
  '## Background',
  '',
  'Builds take too long.',
  '',
  '## Idea',
  '',
  'Cache harder.',
  '',
  '## Open questions',
  '',
  'None yet.',
  '',
].join('\n');

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'janus-notes-'));
  writeFileSync(join(root, 'setup-marker'), 'x');
  mkdirSync(join(root, '.agents', 'notes'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.json'),
    JSON.stringify({ schemaVersion: 1, repoId: REPO, name: 'T', profile: SUPPORTED_HARNESS_PROFILE }),
  );
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-fast--11111111.md'), IDEA_MD);
  return root;
}

describe('janus notes argv', () => {
  it('parses the notes group with raw args passthrough', () => {
    const parsed = parseArgs(['notes', '--root', '/tmp/r', '--json', 'list', '--kind', 'idea'], '/base');
    expect(parsed.command).toBe('notes');
    expect(parsed.notes).toMatchObject({ workspace: '/base' });
    expect(parsed.notes?.args).toEqual(['--root', '/tmp/r', '--json', 'list', '--kind', 'idea']);
  });

  it('mentions notes in help', async () => {
    const { helpText } = await import('../src/args.js');
    expect(helpText()).toContain('janus notes');
  });
});

describe('janus notes commands', () => {
  it('lists, shows, and checks a checkout', async () => {
    const root = checkout();
    try {
      const listed = await runNotes(['--root', root, '--json', 'list'], root);
      expect(listed.exit).toBe(0);
      const body = JSON.parse(listed.stdout) as { ok: boolean; data: { notes: Array<{ id: string; uri: string }> } };
      expect(body.ok).toBe(true);
      expect(body.data.notes).toHaveLength(1);
      expect(body.data.notes[0]?.uri).toBe(`note://${REPO}/11111111-1111-4111-8111-111111111111`);
      const shown = await runNotes(['--root', root, 'show', '11111111-1111-4111-8111-111111111111'], root);
      expect(shown.exit).toBe(0);
      expect(shown.stdout).toContain('# Fast builds');
      const checked = await runNotes(['--root', root, '--json', 'check'], root);
      expect(checked.exit).toBe(0);
      expect(JSON.parse(checked.stdout).data.files).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a draft through the shared command function', async () => {
    const root = checkout();
    try {
      writeFileSync(join(root, 'body.md'), '## Background\n\nB.\n\n## Idea\n\nI.\n\n## Open questions\n\nNone.\n');
      const created = await runNotes(
        ['--root', root, '--json', 'create', '--kind', 'idea', '--title', 'Second', '--body-file', 'body.md'],
        root,
      );
      expect(created.exit).toBe(0);
      const body = JSON.parse(created.stdout) as { ok: boolean; data: { id: string; uri: string } };
      expect(body.data.uri).toMatch(new RegExp(`^note://${REPO}/`));
      const relisted = await runNotes(['--root', root, '--json', 'list'], root);
      expect((JSON.parse(relisted.stdout) as { data: { notes: unknown[] } }).data.notes).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps failures to the fixed exit codes with the shared envelope', async () => {
    const root = checkout();
    try {
      const missing = await runNotes(['--root', root, '--json', 'show', 'nope'], root);
      expect(missing.exit).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false });
      const badApply = await runNotes(['--root', root, '--json', 'apply', 'does-not-exist.json'], root);
      expect(badApply.exit).toBe(2);
      const missingRoot = await runNotes(
        ['--root', root, '--json', 'create', '--kind', 'idea', '--title', 'X', '--body-file', 'absent.md'],
        root,
      );
      expect(missingRoot.exit).toBe(5);
      const usage = await runNotes([], root);
      expect(usage.exit).toBe(2);
      expect(usage.stdout).toContain('janus notes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
