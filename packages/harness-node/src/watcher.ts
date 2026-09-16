/**
 * External-change watcher (contract C5, observer half).
 * Managed writes go through transaction.ts; this module only reports
 * facts seen on disk: upserts, removals, and invalid files. It never
 * approves, merges, or rewrites anything. `rescan()` is the deterministic
 * primitive (startup, focus return, branch switch, overflow recovery);
 * live `fs.watch` events only schedule one.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseNote, validateNote, type Diagnostic } from '@janus-agent/harness-core';
import { currentHash } from './journal.js';
import { listNoteFiles } from './repository.js';

export type WatchEvent =
  | { type: 'upsert'; relPath: string; sha256: string }
  | { type: 'remove'; relPath: string }
  | { type: 'invalid'; relPath: string; diagnostics: Diagnostic[] };

export interface WatchHandle {
  close: () => void;
  rescan: () => Promise<WatchEvent[]>;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const { files } = await listNoteFiles(root);
  const out = new Map<string, string>();
  for (const f of files) {
    const h = await currentHash(root, f.relPath);
    if (h !== null) out.set(f.relPath, h);
  }
  return out;
}

async function watchedDirs(root: string): Promise<string[]> {
  const base = resolve(root, '.agents', 'notes');
  const dirs = [base];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const full = join(dir, e.name);
        dirs.push(full);
        await walk(full);
      }
    }
  };
  await walk(base);
  return dirs;
}

/** Parse-light validity probe: frontmatter splits and H1 exists. Full checks belong to `check`. */
async function probeInvalid(root: string, relPath: string): Promise<Diagnostic[] | null> {
  try {
    const note = parseNote(await readFile(resolve(root, relPath), 'utf8'));
    const diags = validateNote(note);
    return diags.length > 0 ? diags : null;
  } catch (e) {
    return [{ code: (e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID', message: (e as Error).message, path: relPath }];
  }
}

export async function watchNotes(root: string, listener: (events: WatchEvent[]) => void): Promise<WatchHandle> {
  let prev = await snapshot(root);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const fire = async (): Promise<void> => {
    if (closed) return;
    const events = await diff(root, prev);
    prev = await snapshot(root);
    if (events.length > 0) listener(events);
  };
  const schedule = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void fire();
    }, 80);
  };
  const watchers: FSWatcher[] = [];
  try {
    for (const dir of await watchedDirs(root)) {
      try {
        const w = watch(dir, { persistent: false }, () => schedule());
        watchers.push(w);
      } catch {
        // Best effort; rescan() always remains.
      }
    }
  } catch {
    // No notes dir yet; rescan covers later creation.
  }
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
    rescan: async () => {
      const events = await diff(root, prev);
      prev = await snapshot(root);
      return events;
    },
  };
}

async function diff(root: string, prev: Map<string, string>): Promise<WatchEvent[]> {
  const next = await snapshot(root);
  const events: WatchEvent[] = [];
  for (const [rel, hash] of next) {
    if (prev.get(rel) !== hash) {
      const invalid = await probeInvalid(root, rel);
      events.push(
        invalid
          ? { type: 'invalid', relPath: rel, diagnostics: invalid }
          : { type: 'upsert', relPath: rel, sha256: hash },
      );
    }
  }
  for (const rel of prev.keys()) {
    if (!next.has(rel)) events.push({ type: 'remove', relPath: rel });
  }
  return events;
}
