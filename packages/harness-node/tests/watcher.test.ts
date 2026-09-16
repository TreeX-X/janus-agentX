/** Watcher facts: external bytes surface, invalid files diagnose, originals stay. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchNotes, type WatchEvent } from '../src/index.js';
import { makeRepo, requirementNote, writeNote } from './helpers.js';

const ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const waitFor = async (events: WatchEvent[][], want: (e: WatchEvent) => boolean, ms = 5000): Promise<WatchEvent> => {
  const start = Date.now();
  for (;;) {
    for (const batch of events) {
      const hit = batch.find(want);
      if (hit) return hit;
    }
    if (Date.now() - start > ms) throw new Error('watch event timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('watcher', () => {
  it('reports external writes with the new hash', async () => {
    const root = makeRepo();
    const rel = writeNote(root, '2026-09-16-t--aaaaaaaa.md', requirementNote(ID));
    const seen: WatchEvent[][] = [];
    const handle = await watchNotes(root, (batch) => seen.push(batch));
    try {
      writeFileSync(join(root, rel), requirementNote(ID).replace('P.', 'P external.'));
      const hit = await waitFor(seen, (e) => e.type === 'upsert' && e.relPath === rel);
      expect((hit as { sha256: string }).sha256).toHaveLength(64);
    } finally {
      handle.close();
    }
  });
  it('diagnoses invalid files without touching bytes', async () => {
    const root = makeRepo();
    const handle = await watchNotes(root, () => undefined);
    try {
      const rel = writeNote(root, '2026-09-16-bad--bbbbbbbb.md', 'no frontmatter here\n');
      const events = await handle.rescan();
      const hit = events.find((e) => e.type === 'invalid' && e.relPath === rel);
      expect(hit).toBeDefined();
      expect(readFileSync(join(root, rel), 'utf8')).toBe('no frontmatter here\n');
    } finally {
      handle.close();
    }
  });
});
