/**
 * Receipt shape and effective validity (contract C4, use cases F06-F07).
 * A receipt is immutable evidence: contract pin, code manifest, checks,
 * per-criterion coverage, and review verdict. Validity always re-derives
 * from current contract/inputs/code; cached verdicts never substitute.
 */
// Note: completion requires a complete live proof — see .agents/notes/implemented/bug-fix/2026-09-18-harness-receipt-gates.md
import { AC_ID_RE, HEX64_RE, NOTE_URI_RE, UUID_RE, type AcceptanceRef, type Diagnostic, type VerificationStep } from './schema.js';
import { badPath } from './parse.js';
import { sha256Hex } from './hash.js';

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
  command?: { program: string; args: string[]; cwd: string };
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

/** Review identity covers the complete, order-independent manifest including deletions. */
export function codeManifestHash(manifest: Receipt['codeManifest']): string {
  const sorted = [...manifest].sort((a, b) => {
    const left = codeKey(a.repoId, a.path);
    const right = codeKey(b.repoId, b.path);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return sha256Hex(JSON.stringify(sorted.map((row) => [row.repoId, row.path, row.sha256 ?? null, row.deleted === true])));
}

export function validateReceiptShape(r: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const matches = (v: unknown, re: RegExp): boolean => typeof v === 'string' && re.test(v);
  const invalid = (path: string, message: string): void => { out.push(diag('SCHEMA_INVALID', message, path)); };
  const rows = (field: string): Record<string, unknown>[] => {
    const value = (r as Record<string, unknown>)[field];
    if (!Array.isArray(value)) { invalid(field, `${field} must be an array`); return []; }
    const valid: Record<string, unknown>[] = [];
    value.forEach((row, i) => {
      if (!object(row)) invalid(`${field}[${i}]`, 'entry must be an object');
      else valid.push(row);
    });
    return valid;
  };
  const unique = (values: unknown[], path: string): void => {
    if (new Set(values).size !== values.length) invalid(path, 'duplicate entries');
  };
  if (!object(r)) return [diag('SCHEMA_INVALID', 'receipt must be an object')];
  const v = r as Record<string, unknown>;
  if (v['schema'] !== 'harness-receipt/1') out.push(diag('SCHEMA_INVALID', 'bad receipt schema', 'schema'));
  if (typeof v['id'] !== 'string' || !v['id']) out.push(diag('SCHEMA_INVALID', 'receipt needs id', 'id'));
  if (v['taskUri'] !== undefined && (typeof v['taskUri'] !== 'string' || !NOTE_URI_RE.test(v['taskUri']))) {
    out.push(diag('SCHEMA_INVALID', 'bad taskUri', 'taskUri'));
  }
  if (!['xdo', 'xdel', 'xflow'].includes(String(v['mode']))) out.push(diag('SCHEMA_INVALID', 'bad mode', 'mode'));
  if (!Number.isInteger(v['attempt']) || (v['attempt'] as number) < 0) invalid('attempt', 'attempt must be a non-negative integer');
  if (!text(v['actor'])) invalid('actor', 'receipt needs an actor');
  if (!text(v['createdAt']) || !Number.isFinite(Date.parse(v['createdAt']))) invalid('createdAt', 'receipt needs a timestamp');
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
  const inputs = rows('inputs');
  for (const [i, input] of inputs.entries()) {
    if (!matches(input['uri'], NOTE_URI_RE) || !matches(input['contentHash'], HEX64_RE)) invalid(`inputs[${i}]`, 'input needs a note URI and hash');
    if (input['criteria'] !== undefined) {
      if (!Array.isArray(input['criteria']) || !input['criteria'].every((id) => matches(id, AC_ID_RE))) invalid(`inputs[${i}].criteria`, 'criteria must contain AC ids');
      else unique(input['criteria'], `inputs[${i}].criteria`);
    }
  }
  unique(inputs.map((input) => input['uri']), 'inputs');
  const manifest = rows('codeManifest');
  for (const [i, row] of manifest.entries()) {
    const deleted = row['deleted'] === true;
    if (!matches(row['repoId'], UUID_RE) || badPath(row['path']) || row['path'] === '.' || (typeof row['path'] === 'string' && row['path'].endsWith('/'))) invalid(`codeManifest[${i}]`, 'manifest needs a repository id and relative file path');
    if (deleted ? row['sha256'] !== undefined : !matches(row['sha256'], HEX64_RE)) invalid(`codeManifest[${i}]`, 'manifest needs exactly one of sha256 or deleted=true');
    if (row['deleted'] !== undefined && typeof row['deleted'] !== 'boolean') invalid(`codeManifest[${i}].deleted`, 'deleted must be boolean');
  }
  unique(manifest.map((row) => `${row['repoId']} ${row['path']}`), 'codeManifest');
  const checks = rows('checks');
  if (checks.length < 1) {
    out.push(diag('SCHEMA_INVALID', 'at least one check required', 'checks'));
  } else {
    for (const [i, c] of checks.entries()) {
      if (!text(c['id']) || !['command', 'manual'].includes(String(c['kind'])) || typeof c['required'] !== 'boolean' || !['passed', 'failed', 'not-run'].includes(String(c['status'])) || !matches(c['repoId'], UUID_RE) || !text(c['summary']) || !text(c['performedBy'])) {
        out.push(diag('SCHEMA_INVALID', 'bad check entry', `checks[${i}]`));
      }
      if (c['kind'] === 'command' && c['status'] === 'passed' && c['exitCode'] !== 0) {
        out.push(diag('SCHEMA_INVALID', 'passed command needs exitCode 0', `checks[${i}].exitCode`));
      }
      if (c['exitCode'] !== undefined && !Number.isInteger(c['exitCode'])) invalid(`checks[${i}].exitCode`, 'exit code must be an integer');
      if (c['command'] !== undefined) {
        const command = c['command'];
        if (!object(command) || !text(command['program']) || !Array.isArray(command['args']) || !command['args'].every((arg) => typeof arg === 'string') || badPath(command['cwd'])) invalid(`checks[${i}].command`, 'command needs program, args and relative cwd');
      }
    }
  }
  unique(checks.map((check) => check['id']), 'checks');
  const coverage = rows('coverage');
  for (const [i, c] of coverage.entries()) {
    if (!matches(c['uri'], NOTE_URI_RE) || !matches(c['criterionId'], AC_ID_RE) || !matches(c['criterionHash'], HEX64_RE) || !Array.isArray(c['checkIds']) || c['checkIds'].length < 1 || !c['checkIds'].every(text)) {
      out.push(diag('SCHEMA_INVALID', 'bad coverage entry', `coverage[${i}]`));
    } else {
      unique(c['checkIds'], `coverage[${i}].checkIds`);
      if (c['checkIds'].some((id) => !checks.some((check) => check['id'] === id))) invalid(`coverage[${i}].checkIds`, 'coverage refers to an unknown check');
    }
  }
  unique(coverage.map((row) => `${row['uri']} ${row['criterionId']}`), 'coverage');
  const rev = object(v['review']) ? v['review'] : undefined;
  if (!rev || !['self', 'independent', 'manual'].includes(String(rev['kind']))) {
    out.push(diag('SCHEMA_INVALID', 'bad review kind', 'review.kind'));
  }
  if (!rev || !['approved', 'needs-fix', 'blocked'].includes(String(rev['verdict']))) {
    out.push(diag('SCHEMA_INVALID', 'bad review verdict', 'review.verdict'));
  }
  if (!rev || !text(rev['actor']) || !matches(rev['reviewedManifestHash'], HEX64_RE)) invalid('review', 'review needs an actor and manifest hash');
  if (String(v['mode']) === 'xflow' && rev && rev['kind'] !== 'independent') {
    out.push(diag('SCHEMA_INVALID', 'xflow needs an independent review', 'review'));
  }
  return out;
}

export interface ValidityContext {
  taskContractHash: string;
  inputHashes: Map<string, string>;
  /** criterionId -> current criterion hash per note URI. */
  criterionHashes: Map<string, Map<string, string>>;
  /** A present null entry proves absence; a missing key means not checked. */
  codeHashes: Map<string, string | null>;
  acceptanceRefs: AcceptanceRef[];
  verification: VerificationStep[];
  implementor: string;
}

/** Effective validity against the live contract, inputs, criteria, and code. */
export function evaluateReceipt(r: Receipt, ctx: ValidityContext): Diagnostic[] {
  const out = validateReceiptShape(r);
  if (out.length > 0) return out;
  if (r.taskContractHash && r.taskContractHash !== ctx.taskContractHash) {
    out.push(diag('STALE_BASELINE', 'contract moved since this receipt'));
  }
  for (const input of r.inputs) {
    const live = ctx.inputHashes.get(input.uri);
    if (live !== input.contentHash) {
      out.push(diag('STALE_BASELINE', `input drifted: ${input.uri}`, 'inputs'));
    }
  }
  for (const uri of ctx.inputHashes.keys()) {
    if (!r.inputs.some((input) => input.uri === uri)) out.push(diag('STALE_BASELINE', `receipt omits a pinned input: ${uri}`, 'inputs'));
  }
  for (const step of ctx.verification) {
    const check = r.checks.find((row) => row.id === step.id);
    if (!check || check.kind !== step.kind || check.repoId !== step.repoId || check.required !== step.required) {
      out.push(diag('NOT_READY', `receipt does not match declared check: ${step.id}`, `checks.${step.id}`));
    } else if (step.kind === 'command' && (check.command?.program !== step.program || check.command?.cwd !== step.cwd || JSON.stringify(check.command?.args) !== JSON.stringify(step.args))) {
      out.push(diag('NOT_READY', `receipt ran a different command: ${step.id}`, `checks.${step.id}.command`));
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
    if (live !== cov.criterionHash) {
      out.push(diag('STALE_BASELINE', `${cov.criterionId} text moved`, 'coverage'));
    }
  }
  if (r.taskUri && ctx.acceptanceRefs.length === 0) out.push(diag('NOT_READY', 'task has no resolved acceptance criteria', 'coverage'));
  for (const ref of ctx.acceptanceRefs) {
    if (!r.coverage.some((cov) => cov.uri === ref.uri && cov.criterionId === ref.criterionId)) out.push(diag('NOT_READY', `receipt omits required acceptance: ${ref.uri}#${ref.criterionId}`, 'coverage'));
  }
  for (const f of r.codeManifest) {
    const live = ctx.codeHashes.get(codeKey(f.repoId, f.path));
    if (live !== (f.deleted ? null : f.sha256)) {
      out.push(diag('STALE_BASELINE', `code drifted: ${f.path}`, 'codeManifest'));
    }
  }
  if (r.review.verdict !== 'approved') out.push(diag('NOT_READY', `review is ${r.review.verdict}`, 'review.verdict'));
  if (r.review.reviewedManifestHash !== codeManifestHash(r.codeManifest)) out.push(diag('STALE_BASELINE', 'review does not cover this code manifest', 'review.reviewedManifestHash'));
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
