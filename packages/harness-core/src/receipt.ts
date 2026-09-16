/**
 * Receipt shape and effective validity (contract C4, use cases F06-F07).
 * A receipt is immutable evidence: contract pin, code manifest, checks,
 * per-criterion coverage, and review verdict. Validity always re-derives
 * from current contract/inputs/code; cached verdicts never substitute.
 */
import { HEX64_RE, NOTE_URI_RE, type Diagnostic } from './schema.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

/** Join key for per-file live hashes. Shared so callers build identical keys. */
export function codeKey(repoId: string, path: string): string {
  return `${repoId} ${path}`;
}

export interface ReceiptCheck {
  id: string;
  kind: 'command' | 'manual';
  required: boolean;
  status: 'passed' | 'failed' | 'not-run';
  repoId: string;
  exitCode?: number;
  summary: string;
  performedBy: string;
}

export interface ReceiptCoverage {
  uri: string;
  criterionId: string;
  criterionHash: string;
  checkIds: string[];
}

export interface Receipt {
  schema: 'harness-receipt/1';
  id: string;
  taskUri?: string;
  mode: 'xdo' | 'xdel' | 'xflow';
  attempt: number;
  taskContractHash?: string;
  inputs: Array<{ uri: string; contentHash: string; criteria?: string[] }>;
  codeManifest: Array<{ repoId: string; path: string; sha256?: string; deleted?: boolean }>;
  checks: ReceiptCheck[];
  coverage: ReceiptCoverage[];
  review: { kind: 'self' | 'independent' | 'manual'; verdict: 'approved' | 'needs-fix' | 'blocked'; reviewedManifestHash: string; actor: string };
  createdAt: string;
  actor: string;
}

export function validateReceiptShape(r: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return [diag('SCHEMA_INVALID', 'receipt must be an object')];
  const v = r as Record<string, unknown>;
  if (v['schema'] !== 'harness-receipt/1') out.push(diag('SCHEMA_INVALID', 'bad receipt schema', 'schema'));
  if (typeof v['id'] !== 'string' || !v['id']) out.push(diag('SCHEMA_INVALID', 'receipt needs id', 'id'));
  if (v['taskUri'] !== undefined && (typeof v['taskUri'] !== 'string' || !NOTE_URI_RE.test(v['taskUri']))) {
    out.push(diag('SCHEMA_INVALID', 'bad taskUri', 'taskUri'));
  }
  if (!['xdo', 'xdel', 'xflow'].includes(String(v['mode']))) out.push(diag('SCHEMA_INVALID', 'bad mode', 'mode'));
  const both = v['taskUri'] !== undefined || v['taskContractHash'] !== undefined;
  if (v['taskUri'] === undefined && v['taskContractHash'] === undefined && v['mode'] !== 'xdo') {
    out.push(diag('SCHEMA_INVALID', 'taskUri+contractHash required except taskless xdo'));
  }
  if (both && (v['taskUri'] === undefined || v['taskContractHash'] === undefined)) {
    out.push(diag('SCHEMA_INVALID', 'taskUri and taskContractHash travel together'));
  }
  if (
    typeof v['taskContractHash'] !== 'undefined' &&
    (typeof v['taskContractHash'] !== 'string' || !HEX64_RE.test(v['taskContractHash']))
  ) {
    out.push(diag('SCHEMA_INVALID', 'bad taskContractHash', 'taskContractHash'));
  }
  if (!Array.isArray(v['checks']) || (v['checks'] as unknown[]).length < 1) {
    out.push(diag('SCHEMA_INVALID', 'at least one check required', 'checks'));
  } else {
    for (const [i, c] of (v['checks'] as Record<string, unknown>[]).entries()) {
      if (!c['id'] || !c['kind'] || c['required'] === undefined || !c['status'] || !c['summary'] || !c['performedBy']) {
        out.push(diag('SCHEMA_INVALID', 'bad check entry', `checks[${i}]`));
      }
      if (c['kind'] === 'command' && c['status'] === 'passed' && c['exitCode'] !== 0) {
        out.push(diag('SCHEMA_INVALID', 'passed command needs exitCode 0', `checks[${i}].exitCode`));
      }
    }
  }
  if (!Array.isArray(v['coverage'])) out.push(diag('SCHEMA_INVALID', 'coverage must be an array', 'coverage'));
  else {
    for (const [i, c] of (v['coverage'] as Record<string, unknown>[]).entries()) {
      if (!c['uri'] || !c['criterionId'] || !c['criterionHash'] || !Array.isArray(c['checkIds']) || c['checkIds'].length < 1) {
        out.push(diag('SCHEMA_INVALID', 'bad coverage entry', `coverage[${i}]`));
      }
    }
  }
  const rev = v['review'] as Record<string, unknown> | undefined;
  if (!rev || !['self', 'independent', 'manual'].includes(String(rev['kind']))) {
    out.push(diag('SCHEMA_INVALID', 'bad review kind', 'review.kind'));
  }
  if (!rev || !['approved', 'needs-fix', 'blocked'].includes(String(rev['verdict']))) {
    out.push(diag('SCHEMA_INVALID', 'bad review verdict', 'review.verdict'));
  }
  if (String(v['mode']) === 'xflow' && rev && (rev['kind'] !== 'independent' || rev['verdict'] !== 'approved')) {
    out.push(diag('SCHEMA_INVALID', 'xflow needs an approving independent review', 'review'));
  }
  return out;
}

export interface ValidityContext {
  taskContractHash: string;
  inputHashes: Map<string, string>;
  /** criterionId -> current criterion hash per note URI. */
  criterionHashes: Map<string, Map<string, string>>;
  codeHashes: Map<string, string>;
  implementor: string;
}

/** Effective validity against the live contract, inputs, criteria, and code. */
export function evaluateReceipt(r: Receipt, ctx: ValidityContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (r.taskContractHash && r.taskContractHash !== ctx.taskContractHash) {
    out.push(diag('STALE_BASELINE', 'contract moved since this receipt'));
  }
  for (const input of r.inputs) {
    const live = ctx.inputHashes.get(input.uri);
    if (live && live !== input.contentHash) {
      out.push(diag('STALE_BASELINE', `input drifted: ${input.uri}`, 'inputs'));
    }
  }
  const passed = new Set(r.checks.filter((c) => c.status === 'passed').map((c) => c.id));
  for (const c of r.checks) {
    if (c.required && c.status !== 'passed') {
      out.push(diag('NOT_READY', `required check not passed: ${c.id}`, `checks.${c.id}`));
    }
  }
  for (const cov of r.coverage) {
    for (const id of cov.checkIds) {
      if (!passed.has(id)) out.push(diag('NOT_READY', `${cov.criterionId} cites no passing check`, 'coverage'));
    }
    const live = ctx.criterionHashes.get(cov.uri)?.get(cov.criterionId);
    if (live && live !== cov.criterionHash) {
      out.push(diag('STALE_BASELINE', `${cov.criterionId} text moved`, 'coverage'));
    }
  }
  for (const f of r.codeManifest) {
    if (f.deleted) continue;
    const live = ctx.codeHashes.get(codeKey(f.repoId, f.path));
    if (f.sha256 && live && live !== f.sha256) {
      out.push(diag('STALE_BASELINE', `code drifted: ${f.path}`, 'codeManifest'));
    }
  }
  if (r.mode === 'xflow' && (r.review.kind !== 'independent' || r.review.actor === r.actor || r.review.actor === ctx.implementor)) {
    out.push(diag('SCHEMA_INVALID', 'xflow review must come from a different identity', 'review.actor'));
  }
  return out;
}

/** Covered AC count over the required set. Empty required set reports undefined, never 100%. */
export function coverageRatio(covered: number, required: number): number | undefined {
  if (required <= 0) return undefined;
  return covered / required;
}
