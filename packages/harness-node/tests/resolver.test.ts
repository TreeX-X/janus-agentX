/** Checkout resolve: exact, single, chosen, or an explicit question. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkoutMatchesRepo, resolveCheckout } from '../src/index.js';
import { REPO } from './helpers.js';

function checkout(repoId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'harness.json'), JSON.stringify({ schemaVersion: 1, repoId }));
  return dir;
}

describe('resolver', () => {
  it('resolves the single live checkout', async () => {
    const path = checkout(REPO);
    const r = await resolveCheckout({ repoId: REPO, candidates: [{ checkoutId: 'a', path }] });
    expect(r).toEqual({ ok: true, checkoutId: 'a', path });
  });
  it('asks instead of silently picking among several', async () => {
    const a = checkout(REPO);
    const b = checkout(REPO);
    const r = await resolveCheckout({ repoId: REPO, candidates: [{ checkoutId: 'a', path: a }, { checkoutId: 'b', path: b }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0].code).toBe('APPROVAL_REQUIRED');
  });
  it('honors an explicit selected binding', async () => {
    const a = checkout(REPO);
    const b = checkout(REPO);
    const r = await resolveCheckout({
      repoId: REPO,
      candidates: [{ checkoutId: 'a', path: a }, { checkoutId: 'b', path: b }],
      map: { version: 1, bindings: [{ repoId: REPO, checkoutId: 'b', path: b, selected: true }] },
    });
    expect(r).toEqual({ ok: true, checkoutId: 'b', path: b });
  });
  it('reports missing checkouts and identity mismatches', async () => {
    const missing = await resolveCheckout({ repoId: REPO, candidates: [{ checkoutId: 'x', path: join(tmpdir(), 'nope-xyz') }] });
    expect(missing.ok).toBe(false);
    await expect(checkoutMatchesRepo(checkout('other-repo'), REPO)).resolves.toBe(false);
  });
});
