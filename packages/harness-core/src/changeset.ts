/**
 * Change-set and bundle validation (contract C5-C6).
 * One `afterMarkdown` per operation is the single source of truth;
 * bundle artifacts only reference operation ids plus source maps.
 */
import { HEX64_RE, NOTE_URI_RE, type Diagnostic } from './schema.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

export interface ChangeOperation {
  operationId: string;
  type: 'create' | 'replace' | 'delete';
  uri: string;
  expectedHash: string | null;
  relativePath?: string;
  afterMarkdown?: string;
  dependsOn: string[];
  reason: string;
  evidenceRefs: string[];
}

export interface ChangeSet {
  id: string;
  revision: number;
  source: { type: 'roundtable' | 'chat' | 'harness' | 'manual'; id: string; revision: number };
  operations: ChangeOperation[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateChangeSet(cs: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isRecord(cs)) return [diag('SCHEMA_INVALID', 'changeset must be an object')];
  if (typeof cs['id'] !== 'string' || !cs['id']) out.push(diag('SCHEMA_INVALID', 'changeset needs id', 'id'));
  if (typeof cs['revision'] !== 'number' || (cs['revision'] as number) < 1) {
    out.push(diag('SCHEMA_INVALID', 'revision starts at 1', 'revision'));
  }
  const src = cs['source'];
  if (!isRecord(src) || !['roundtable', 'chat', 'harness', 'manual'].includes(String(src['type']))) {
    out.push(diag('SCHEMA_INVALID', 'bad source', 'source'));
  }
  if (!Array.isArray(cs['operations']) || (cs['operations'] as unknown[]).length < 1) {
    return [...out, diag('SCHEMA_INVALID', 'at least one operation required', 'operations')];
  }
  const ops = cs['operations'] as Record<string, unknown>[];
  const ids = new Set<string>();
  for (const [i, o] of ops.entries()) {
    const at = `operations[${i}]`;
    if (!isRecord(o)) {
      out.push(diag('SCHEMA_INVALID', 'bad operation', at));
      continue;
    }
    if (typeof o['operationId'] !== 'string' || !o['operationId']) {
      out.push(diag('SCHEMA_INVALID', 'operation needs operationId', `${at}.operationId`));
    } else if (ids.has(o['operationId'])) {
      out.push(diag('SCHEMA_INVALID', 'duplicate operationId', `${at}.operationId`));
    } else ids.add(o['operationId']);
    if (!['create', 'replace', 'delete'].includes(String(o['type']))) {
      out.push(diag('SCHEMA_INVALID', 'bad operation type', `${at}.type`));
    }
    if (typeof o['uri'] !== 'string' || !NOTE_URI_RE.test(o['uri'])) {
      out.push(diag('SCHEMA_INVALID', 'bad uri', `${at}.uri`));
    }
    if (o['type'] === 'create') {
      if (o['expectedHash'] !== null) out.push(diag('SCHEMA_INVALID', 'create pins expectedHash null', `${at}.expectedHash`));
      if (typeof o['afterMarkdown'] !== 'string' || !o['afterMarkdown']) {
        out.push(diag('SCHEMA_INVALID', 'create/replace need afterMarkdown', `${at}.afterMarkdown`));
      }
    } else if (o['type'] === 'replace') {
      if (typeof o['expectedHash'] !== 'string' || !HEX64_RE.test(o['expectedHash'])) {
        out.push(diag('SCHEMA_INVALID', 'replace needs exact expectedHash', `${at}.expectedHash`));
      }
      if (typeof o['afterMarkdown'] !== 'string' || !o['afterMarkdown']) {
        out.push(diag('SCHEMA_INVALID', 'create/replace need afterMarkdown', `${at}.afterMarkdown`));
      }
    } else if (o['type'] === 'delete') {
      if (typeof o['expectedHash'] !== 'string' || !HEX64_RE.test(o['expectedHash'])) {
        out.push(diag('SCHEMA_INVALID', 'delete needs exact expectedHash', `${at}.expectedHash`));
      }
      if (o['afterMarkdown'] !== undefined) {
        out.push(diag('SCHEMA_INVALID', 'delete carries no prose', `${at}.afterMarkdown`));
      }
    }
    if (!Array.isArray(o['dependsOn'])) out.push(diag('SCHEMA_INVALID', 'dependsOn must be an array', `${at}.dependsOn`));
    if (o['relativePath'] !== undefined && typeof o['relativePath'] === 'string') {
      const p = o['relativePath'];
      if (p.startsWith('/') || p.includes('..') || p.includes('\\')) {
        out.push(diag('SCHEMA_INVALID', 'bad relativePath', `${at}.relativePath`));
      }
    }
  }
  // dependsOn closure: targets exist and form no loop.
  const color = new Map<string, number>();
  let loop: string[] | null = null;
  const byId = new Map(ops.map((o) => [String(o['operationId']), o]));
  const visitOp = (id: string, stack: string[]): void => {
    if (loop) return;
    color.set(id, 1);
    stack.push(id);
    const deps = byId.get(id)?.['dependsOn'];
    if (Array.isArray(deps)) {
      for (const d of deps) {
        if (typeof d !== 'string' || !byId.has(d)) {
          out.push(diag('SCHEMA_INVALID', `unknown dependsOn ${String(d)}`, 'operations'));
          continue;
        }
        const c = color.get(d) ?? 0;
        if (c === 0) visitOp(d, stack);
        else if (c === 1) {
          loop = [...stack.slice(stack.indexOf(d)), d];
          return;
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of byId.keys()) {
    if ((color.get(id) ?? 0) === 0) visitOp(id, []);
    if (loop) break;
  }
  if (loop) out.push(diag('SCHEMA_INVALID', `dependsOn cycle: ${(loop as string[]).join(' -> ')}`));
  return out;
}

export function validateBundle(b: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isRecord(b)) return [diag('SCHEMA_INVALID', 'bundle must be an object')];
  if (b['schema'] !== 'harness-bundle/1') out.push(diag('SCHEMA_INVALID', 'bad bundle schema', 'schema'));
  if (typeof b['revision'] !== 'number' || (b['revision'] as number) < 1) {
    out.push(diag('SCHEMA_INVALID', 'bundle revision starts at 1', 'revision'));
  }
  const artifacts = b['artifacts'];
  if (!Array.isArray(artifacts)) {
    out.push(diag('SCHEMA_INVALID', 'artifacts must be an array', 'artifacts'));
  } else {
    for (const [i, a] of (artifacts as unknown[]).entries()) {
      if (!isRecord(a) || typeof a['artifactId'] !== 'string' || typeof a['operationId'] !== 'string' || !Array.isArray(a['sourceRefs'])) {
        out.push(diag('SCHEMA_INVALID', 'bad artifact entry', `artifacts[${i}]`));
      }
      if (isRecord(a) && 'afterMarkdown' in a) {
        out.push(diag('SCHEMA_INVALID', 'artifacts carry no forked prose', `artifacts[${i}].afterMarkdown`));
      }
    }
  }
  return out;
}
