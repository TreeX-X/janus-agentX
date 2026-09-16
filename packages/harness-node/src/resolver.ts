/**
 * Checkout resolution (contract: shared identity, local binding).
 * Shared notes never carry machine paths. Binding a repoId to a local
 * checkout is convenience data under `.local/`; missing bindings block
 * writes but never block reading assets already received.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Diagnostic } from '@janus-agent/harness-core';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

export interface CheckoutBinding {
  repoId: string;
  checkoutId: string;
  path: string;
  selected: boolean;
}

export interface WorkspaceMap {
  version: number;
  bindings: CheckoutBinding[];
}

/** Best effort. Absent map means unbound, never an error by itself. */
export async function readWorkspaceMap(repoRoot: string): Promise<{ map: WorkspaceMap | null; diagnostics: Diagnostic[] }> {
  const file = resolve(repoRoot, '.agents', '.local', 'workspace-map.json');
  try {
    const raw = await readFile(file, 'utf8');
    const map = JSON.parse(raw) as WorkspaceMap;
    if (map.version !== 1 || !Array.isArray(map.bindings)) {
      return { map: null, diagnostics: [diag('SCHEMA_INVALID', 'bad workspace-map.json', file)] };
    }
    return { map, diagnostics: [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { map: null, diagnostics: [] };
    return { map: null, diagnostics: [diag('IO_ERROR', `workspace map unreadable: ${(e as Error).message}`, file)] };
  }
}

/** True when the checkout on disk carries the expected repo identity. */
export async function checkoutMatchesRepo(checkoutPath: string, repoId: string): Promise<boolean> {
  try {
    const raw = await readFile(resolve(checkoutPath, '.agents', 'harness.json'), 'utf8');
    return (JSON.parse(raw) as { repoId?: unknown }).repoId === repoId;
  } catch {
    return false;
  }
}

export interface ResolveArgs {
  repoId: string;
  candidates: Array<{ checkoutId: string; path: string }>;
  map?: WorkspaceMap | null;
}

/**
 * Never silently picks the first of several checkouts. Exactly one live
 * candidate resolves on its own; otherwise the caller must choose.
 */
export async function resolveCheckout(args: ResolveArgs): Promise<
  | { ok: true; checkoutId: string; path: string }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const live = args.candidates.filter((c) => existsSync(c.path));
  const matching: Array<{ checkoutId: string; path: string }> = [];
  for (const c of live) {
    if (await checkoutMatchesRepo(c.path, args.repoId)) matching.push(c);
  }
  const pool = matching.length > 0 ? matching : live;
  if (pool.length === 0) {
    return { ok: false, diagnostics: [diag('NOT_FOUND', `no checkout for repo ${args.repoId}`)] };
  }
  const selected = args.map?.bindings.find((b) => b.repoId === args.repoId && b.selected);
  if (selected) {
    const hit = pool.find((c) => resolve(c.path) === resolve(selected.path));
    if (hit) return { ok: true, ...hit };
  }
  if (pool.length === 1) return { ok: true, ...pool[0] };
  return {
    ok: false,
    diagnostics: [
      diag(
        'APPROVAL_REQUIRED',
        `ambiguous checkout for repo ${args.repoId}: ${pool.map((c) => c.checkoutId).join(', ')}; choose one`,
      ),
    ],
  };
}
