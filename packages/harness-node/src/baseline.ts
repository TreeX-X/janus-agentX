// Note: task baseline collection lives here — see .agents/notes/implemented/architecture/2026-09-17-harness-baseline-s8.md
/**
 * @file Task baseline collection (S8 slice 8b, shared).
 * @description Assembles the fixed C3 baseline for one task note: the task
 *  contract hash plus content digests of related notes. Requirement
 *  predecessors need live acceptance coverage from evidence or run
 *  receipts; task predecessors need a done state with discoverable
 *  receipts. Unresolvable, cyclic, uncovered, or undone predecessors
 *  refuse the baseline with named diagnostics instead of guessing
 *  satisfaction. No models, no network, no execution.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contentDigest,
  criterionHash,
  taskContractHash,
  type BaselineInput,
  type Diagnostic,
  type ParsedNote,
} from '@janus-agent/harness-core';
import { buildNoteIndex, noteUri, sha256HexBytes, type NoteIndex } from './repository.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

/** Edge types that pin execution inputs (contract C2/C3). */
const BASELINE_EDGE_TYPES = ['implements', 'governed-by', 'depends-on'];

/** Normative prose per kind for input digests (contract C3). */
const NORMATIVE_SECTIONS: Record<string, string[]> = {
  requirement: ['Problem', 'Expected behavior', 'Scope'],
  decision: ['Problem', 'Proposal', 'Alternatives considered', 'Risks', 'Decision', 'Consequences'],
  initiative: ['Goal', 'Scope'],
  task: ['Scope', 'Acceptance criteria', 'Verification'],
  idea: ['Background', 'Idea'],
};

function sectionMap(note: ParsedNote): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of note.sections) {
    if (!(section.name in out)) out[section.name] = section.text;
  }
  return out;
}

function pickSections(note: ParsedNote, kind: string): Record<string, string> {
  const all = sectionMap(note);
  const out: Record<string, string> = {};
  for (const name of NORMATIVE_SECTIONS[kind] ?? []) {
    if (name in all) out[name] = all[name];
  }
  return out;
}

/** Canonical AC lines (checkbox normalized by the hasher) keyed by stable id. */
function acLines(note: ParsedNote): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ac of note.acs) out[ac.id] = `- [ ] ${ac.id}: ${ac.text}`;
  return out;
}

function tailId(ref: string): string {
  return ref.includes('://') ? (ref.split('/').pop() ?? ref) : ref;
}

interface ReceiptRow {
  id: string;
  coverage: Array<{ uri: string; criterionId: string; criterionHash: string; checkIds: string[] }>;
  checks: Array<{ id: string; required: boolean; status: string }>;
  codeManifest: Array<{ repoId: string; path: string; sha256?: string; deleted?: boolean }>;
}

const RECEIPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function asReceiptRow(id: string, value: unknown): ReceiptRow | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['coverage']) || !Array.isArray(v['checks'])) return null;
  const coverage: ReceiptRow['coverage'] = [];
  for (const c of v['coverage'] as Array<Record<string, unknown>>) {
    if (typeof c['uri'] !== 'string' || typeof c['criterionId'] !== 'string' ||
      typeof c['criterionHash'] !== 'string' || !Array.isArray(c['checkIds']) || c['checkIds'].length < 1) {
      return null;
    }
    coverage.push({
      uri: c['uri'], criterionId: c['criterionId'], criterionHash: c['criterionHash'],
      checkIds: (c['checkIds'] as unknown[]).map(String),
    });
  }
  const checks: ReceiptRow['checks'] = [];
  for (const c of v['checks'] as Array<Record<string, unknown>>) {
    if (typeof c['id'] !== 'string' || typeof c['status'] !== 'string') return null;
    checks.push({ id: c['id'], required: c['required'] === true, status: c['status'] });
  }
  const codeManifest: ReceiptRow['codeManifest'] = [];
  if (Array.isArray(v['codeManifest'])) {
    for (const row of v['codeManifest'] as Array<Record<string, unknown>>) {
      if (typeof row['repoId'] !== 'string' || typeof row['path'] !== 'string') return null;
      codeManifest.push({
        repoId: row['repoId'],
        path: row['path'],
        ...(typeof row['sha256'] === 'string' ? { sha256: row['sha256'] } : {}),
        ...(row['deleted'] === true ? { deleted: true as const } : {}),
      });
    }
  }
  return { id, coverage, checks, codeManifest };
}

async function listEvidenceReceipts(root: string): Promise<ReceiptRow[]> {
  const out: ReceiptRow[] = [];
  const dirs: string[] = [join(root, '.agents', 'evidence')];
  try {
    const runs = await readdir(join(root, '.agents', '.local', 'runs'), { withFileTypes: true });
    for (const run of runs) {
      if (run.isDirectory()) dirs.push(join(root, '.agents', '.local', 'runs', run.name, 'receipts'));
    }
  } catch {
    // No local runs yet: the evidence directory alone decides coverage.
  }
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const row = asReceiptRow(file.replace(/\.json$/, ''), await readJsonFile(join(dir, file)));
      if (row) out.push(row);
    }
  }
  return out;
}

/** Raw bytes of one receipt by id, evidence directory first, then run records. */
async function findReceiptBytes(root: string, receiptId: string): Promise<{ bytes: Uint8Array; from: string } | null> {
  if (!RECEIPT_ID_RE.test(receiptId)) return null;
  const direct = join(root, '.agents', 'evidence', `${receiptId}.json`);
  try {
    const bytes = await readFile(direct);
    return { bytes, from: `evidence/${receiptId}.json` };
  } catch {
    // Fall through to run records.
  }
  let runs: string[] = [];
  try {
    runs = (await readdir(join(root, '.agents', '.local', 'runs'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const run of runs) {
    const path = join(root, '.agents', '.local', 'runs', run, 'receipts', `${receiptId}.json`);
    try {
      const bytes = await readFile(path);
      return { bytes, from: `runs/${run}/receipts/${receiptId}.json` };
    } catch {
      continue;
    }
  }
  return null;
}

export interface CoverageProof {
  covered: boolean;
  uncovered: string[];
  receipts: string[];
}

/**
 * Acceptance coverage for one requirement note: every AC needs a receipt
 * whose criterion hash matches the live AC line, whose cited checks passed
 * with all required checks passed, and whose code manifest still matches
 * the worktree. Expensive on purpose: coverage is a proof, not a guess.
 */
export async function proveRequirementCoverage(
  root: string,
  repoId: string,
  uri: string,
  note: ParsedNote,
): Promise<CoverageProof> {
  const receipts = await listEvidenceReceipts(root);
  const uncovered: string[] = [];
  const used = new Set<string>();
  for (const ac of note.acs) {
    const liveLine = `- [ ] ${ac.id}: ${ac.text}`;
    const liveHash = criterionHash(liveLine);
    let hit = false;
    for (const receipt of receipts) {
      const cov = receipt.coverage.find((c) => c.uri === uri && c.criterionId === ac.id && c.criterionHash === liveHash);
      if (!cov) continue;
      const passed = new Set(receipt.checks.filter((c) => c.status === 'passed').map((c) => c.id));
      if (!cov.checkIds.every((id) => passed.has(id))) continue;
      if (receipt.checks.some((c) => c.required && c.status !== 'passed')) continue;
      let drift = false;
      for (const row of receipt.codeManifest) {
        if (row.repoId !== repoId || row.deleted || !row.sha256) continue;
        try {
          const bytes = await readFile(join(root, row.path));
          if (sha256HexBytes(bytes) !== row.sha256) {
            drift = true;
            break;
          }
        } catch {
          drift = true;
          break;
        }
      }
      if (drift) continue;
      hit = true;
      used.add(receipt.id);
      break;
    }
    if (!hit) uncovered.push(ac.id);
  }
  return { covered: uncovered.length === 0, uncovered, receipts: [...used].sort() };
}

export interface TaskBaseline {
  taskUri: string;
  taskContractHash: string;
  inputs: BaselineInput[];
}

export type BaselineResult =
  | { ok: true; baseline: TaskBaseline }
  | { ok: false; problems: Diagnostic[] };

interface Target {
  uri: string;
  note: ParsedNote;
}

const EXPECTED_KIND: Record<string, string[]> = {
  implements: ['requirement'],
  'governed-by': ['decision'],
  'depends-on': ['requirement', 'task'],
};

export async function collectTaskBaseline(root: string, taskRef: string): Promise<BaselineResult> {
  const problems: Diagnostic[] = [];
  let index: NoteIndex;
  try {
    index = await buildNoteIndex(root);
  } catch (e) {
    return { ok: false, problems: [diag('IO_ERROR', `cannot scan notes under ${root}: ${(e as Error).message}`)] };
  }
  if (!index.repoId) {
    return { ok: false, problems: [diag('NOT_READY', 'init .agents/harness.json with a repoId first')] };
  }
  const repoId = index.repoId;
  const uriOf = (id: string): string => noteUri(repoId, id);
  const taskEntry = index.byId.get(tailId(taskRef))
    ?? index.entries.find((e) => e.relPath === taskRef || e.relPath.endsWith(`/${taskRef}`));
  if (!taskEntry?.note) {
    return { ok: false, problems: [diag('NOT_FOUND', `unknown task note: ${taskRef}`)] };
  }
  if (taskEntry.diagnostics.length > 0) {
    return { ok: false, problems: taskEntry.diagnostics.slice(0, 5) };
  }
  const task = taskEntry.note;
  if (task.meta.kind !== 'task') {
    return { ok: false, problems: [diag('SCHEMA_INVALID', `harness runs need a task note, found ${task.meta.kind}`, 'kind')] };
  }
  if (task.meta.lifecycle !== 'accepted') {
    return { ok: false, problems: [diag('NOT_READY', `task executes only from accepted (now ${task.meta.lifecycle})`, 'lifecycle')] };
  }
  const taskUri = uriOf(task.meta.id);
  // First visit wins per target: relation file order is deterministic, and a
  // pinned subset stays a fixed, verifiable pin. Two edges covering
  // different criteria subsets of one target is pathological; the second
  // edge's extra criteria simply do not extend staleness detection.
  const inputs: BaselineInput[] = [];
  const done = new Set<string>([taskUri]);

  const targetOf = (uri: string): { target: Target } | { missing: boolean } | { invalid: string } => {
    const entry = index.byId.get(tailId(uri));
    if (!entry) return { missing: true };
    if (!entry.note || entry.diagnostics.length > 0) return { invalid: entry.relPath };
    return { target: { uri: uriOf(entry.note.meta.id), note: entry.note } };
  };

  const pinTarget = async (uri: string, via: string, edgeCriteria: string[] | undefined, stack: string[]): Promise<void> => {
    if (done.has(uri)) {
      if (stack.includes(uri)) {
        problems.push(diag('INVALID_RELATION', `dependency cycle: ${[...stack, uri].join(' -> ')}`));
      }
      return;
    }
    const resolved = targetOf(uri);
    if ('missing' in resolved) {
      problems.push(diag('UNRESOLVED_REFERENCE', `unresolved ${via} target: ${uri}`));
      return;
    }
    if ('invalid' in resolved) {
      problems.push(diag('SCHEMA_INVALID', `invalid ${via} target note: ${resolved.invalid}`));
      return;
    }
    const { target } = resolved;
    const kind = target.note.meta.kind;
    if (!(EXPECTED_KIND[via] ?? []).includes(kind)) {
      problems.push(diag('INVALID_RELATION', `${via} needs ${(EXPECTED_KIND[via] ?? []).join('/')} but targets ${kind}: ${uri}`));
      return;
    }
    const lines = acLines(target.note);
    const wanted = edgeCriteria?.length ? edgeCriteria : Object.keys(lines);
    for (const id of edgeCriteria ?? []) {
      if (!(id in lines)) {
        problems.push(diag('INVALID_RELATION', `unknown criterion ${id} on ${uri}`));
        return;
      }
    }
    const criteria: Record<string, string> = {};
    for (const id of wanted) criteria[id] = lines[id];
    done.add(uri);

    if (kind === 'requirement') {
      const proof = await proveRequirementCoverage(root, repoId, target.uri, target.note);
      if (!proof.covered) {
        problems.push(diag('DEPENDENCY_UNSATISFIED', `requirement ${target.uri} has uncovered acceptance: ${proof.uncovered.join(', ')}`));
        return;
      }
      const digest = contentDigest({
        uri: target.uri, kind, lifecycle: target.note.meta.lifecycle,
        sections: pickSections(target.note, kind), criteria,
      });
      inputs.push({ uri: target.uri, contentHash: digest.digest, criteria: Object.keys(criteria) });
    } else if (kind === 'decision') {
      const digest = contentDigest({
        uri: target.uri, kind, lifecycle: target.note.meta.lifecycle,
        sections: pickSections(target.note, kind), criteria: {},
      });
      inputs.push({ uri: target.uri, contentHash: digest.digest });
    } else {
      const execution = target.note.meta.execution;
      if (!execution || execution.state !== 'done') {
        problems.push(diag('DEPENDENCY_UNSATISFIED', `predecessor task is not done: ${target.uri}`));
        return;
      }
      if (!Array.isArray(execution.receipts) || execution.receipts.length === 0) {
        problems.push(diag('UNRESOLVED_REFERENCE', `done predecessor has no recorded receipt: ${target.uri}`));
        return;
      }
      const dependencies: Array<{ uri: string; contractHash: string; receiptHash: string }> = [];
      const depContract = taskContractHash(target.note);
      for (const id of execution.receipts) {
        if (typeof id !== 'string') continue;
        const found = await findReceiptBytes(root, id);
        if (!found) {
          problems.push(diag('UNRESOLVED_REFERENCE', `predecessor receipt not found: ${id} (via ${target.uri})`));
          return;
        }
        dependencies.push({ uri: target.uri, contractHash: depContract, receiptHash: sha256HexBytes(found.bytes) });
      }
      const digest = contentDigest({
        uri: target.uri, kind, lifecycle: target.note.meta.lifecycle,
        sections: pickSections(target.note, kind), criteria,
        dependencies,
      });
      inputs.push({ uri: target.uri, contentHash: digest.digest, criteria: Object.keys(criteria) });
    }

    if (kind === 'requirement' || kind === 'task') {
      for (const rel of target.note.meta.relations ?? []) {
        if (rel.type !== 'depends-on') continue;
        await pinTarget(rel.target, rel.type, rel.criteria, [...stack, target.uri]);
        if (problems.length > 0) return;
      }
    }
  };

  for (const rel of task.meta.relations ?? []) {
    if (!BASELINE_EDGE_TYPES.includes(rel.type)) continue;
    await pinTarget(rel.target, rel.type, rel.criteria, [taskUri]);
    if (problems.length > 0) return { ok: false, problems };
  }
  const sorted = [...inputs].sort((a, b) => (a.uri < b.uri ? -1 : 1));
  return { ok: true, baseline: { taskUri, taskContractHash: taskContractHash(task), inputs: sorted } };
}
