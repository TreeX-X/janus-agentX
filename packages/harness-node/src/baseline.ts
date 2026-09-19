// Note: task baseline collection lives here — see .agents/notes/implemented/architecture/2026-09-17-harness-baseline-s8.md
// Note: eligibility and evidence share one validity gate — see .agents/notes/implemented/bug-fix/2026-09-18-harness-receipt-gates.md
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
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contentDigest,
  canon,
  codeKey,
  criterionHash,
  evaluateReceipt,
  receiptContentHash,
  taskContractHash,
  validateReceiptShape,
  type BaselineInput,
  type Diagnostic,
  type ParsedNote,
  type Receipt,
} from '@janus-agent/harness-core';
import { buildNoteIndex, isWithin, noteUri, sha256HexBytes, type NoteIndex } from './repository.js';
import { assertAssetPath, withAssetLock } from './transaction.js';
import { TaskScope } from './task-scope.js';
import { isGitRepo } from './git-evidence.js';

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

const RECEIPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function listEvidenceReceipts(root: string): Promise<Receipt[]> {
  const out: Receipt[] = [];
  const dirs: string[] = [join(root, '.agents', 'evidence')];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try { await assertAssetPath(root, `.agents/evidence/${file}`); } catch { continue; }
      const value = await readJsonFile(join(dir, file));
      if (validateReceiptShape(value).length === 0 && (value as Receipt).id === file.replace(/\.json$/, '')) out.push(value as Receipt);
    }
  }
  return out;
}

/** Only formal evidence establishes portable completion. */
async function findReceiptBytes(root: string, receiptId: string): Promise<{ bytes: Uint8Array; from: string } | null> {
  if (!RECEIPT_ID_RE.test(receiptId)) return null;
  const direct = join(root, '.agents', 'evidence', `${receiptId}.json`);
  try {
    await assertAssetPath(root, `.agents/evidence/${receiptId}.json`);
    const bytes = await readFile(direct);
    return { bytes, from: `evidence/${receiptId}.json` };
  } catch { return null; }
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
async function proveCoverage(
  root: string,
  repoId: string,
  uri: string,
  note: ParsedNote,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<CoverageProof> {
  const receipts = await listEvidenceReceipts(root);
  const validReceipts: Receipt[] = [];
  for (const receipt of receipts) {
    if (!receipt.coverage.some((cov) => cov.uri === uri)) continue;
    if ((await receiptProblems(root, repoId, receipt, ancestors)).length === 0) validReceipts.push(receipt);
  }
  const uncovered: string[] = [];
  const used = new Set<string>();
  for (const ac of note.acs) {
    const liveLine = `- [ ] ${ac.id}: ${ac.text}`;
    const liveHash = criterionHash(liveLine);
    let hit = false;
    for (const receipt of validReceipts) {
      const cov = receipt.coverage.find((c) => c.uri === uri && c.criterionId === ac.id && c.criterionHash === liveHash);
      if (!cov) continue;
      hit = true;
      used.add(receipt.id);
      break;
    }
    if (!hit) uncovered.push(ac.id);
  }
  return { covered: note.acs.length > 0 && uncovered.length === 0, uncovered, receipts: [...used].sort() };
}

export async function proveRequirementCoverage(root: string, repoId: string, uri: string, note: ParsedNote): Promise<CoverageProof> {
  return withAssetLock(root, () => proveCoverage(root, repoId, uri, note));
}

/** Rebuild validity from the repository; receipt claims never supply live hashes. */
export async function receiptProblems(root: string, repoId: string, receipt: Receipt, ancestors: ReadonlySet<string> = new Set()): Promise<Diagnostic[]> {
  const shape = validateReceiptShape(receipt);
  if (shape.length > 0) return shape;
  const index = await buildNoteIndex(root);
  const lookup = (uri: string): ParsedNote | undefined => {
    if (!uri.startsWith(`note://${repoId}/`)) return undefined;
    const entry = index.byId.get(tailId(uri));
    return entry?.diagnostics.length === 0 ? entry.note : undefined;
  };
  let contract = receipt.taskContractHash ?? '';
  const inputHashes = new Map<string, string>();
  const task = receipt.taskUri ? lookup(receipt.taskUri) : undefined;
  if (receipt.taskUri) {
    if (!task || task.meta.kind !== 'task' || !task.meta.work) return [diag('NOT_READY', 'receipt task is unresolved')];
    if (task.meta.execution?.state !== 'done' || !task.meta.execution.receipts.includes(receipt.id)) return [diag('NOT_READY', 'receipt is not attached to a completed task')];
    if (task.meta.execution && (task.meta.execution.mode !== receipt.mode || task.meta.execution.attempt !== receipt.attempt)) return [diag('STALE_BASELINE', 'receipt differs from the recorded task mode or attempt')];
    const inputsKey = (inputs: BaselineInput[]) => canon(inputs.map((row) => ({ ...row, ...(row.criteria ? { criteria: [...row.criteria].sort() } : {}) })).sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    if (task.meta.execution.baseline.taskContractHash !== receipt.taskContractHash || inputsKey(task.meta.execution.baseline.inputs) !== inputsKey(receipt.inputs)) return [diag('STALE_BASELINE', 'receipt differs from the recorded task baseline')];
    const base = await collectBaseline(root, receipt.taskUri, ancestors);
    if (!base.ok) return base.problems;
    contract = base.baseline.taskContractHash;
    for (const input of base.baseline.inputs) inputHashes.set(input.uri, input.contentHash);
  } else {
    for (const input of receipt.inputs) {
      const note = lookup(input.uri);
      if (!note || !['requirement', 'initiative', 'decision'].includes(note.meta.kind)) return [diag('UNRESOLVED_REFERENCE', `cannot verify input ${input.uri}`)];
      const lines = acLines(note);
      const criteria: Record<string, string> = {};
      for (const id of input.criteria ?? Object.keys(lines)) {
        if (!(id in lines)) return [diag('STALE_BASELINE', `input criterion vanished: ${input.uri}#${id}`)];
        criteria[id] = lines[id];
      }
      inputHashes.set(input.uri, contentDigest({ uri: input.uri, kind: note.meta.kind, lifecycle: note.meta.lifecycle, sections: pickSections(note, note.meta.kind), criteria }).digest);
    }
    for (const cov of receipt.coverage) {
      if (!inputHashes.has(cov.uri)) return [diag('NOT_READY', `taskless receipt does not pin covered input ${cov.uri}`)];
    }
  }
  const criterionHashes = new Map<string, Map<string, string>>();
  for (const cov of receipt.coverage) {
    const note = lookup(cov.uri);
    if (note) criterionHashes.set(cov.uri, new Map(note.acs.map((ac) => [ac.id, criterionHash(`- [ ] ${ac.id}: ${ac.text}`)])));
  }
  const codeHashes = new Map<string, string | null>();
  if (task?.meta.work && isGitRepo(root)) {
    try {
      const current = await new TaskScope(root, repoId, task.meta.work).manifest();
      if (current.some((row) => !receipt.codeManifest.some((recorded) => codeKey(row.repoId, row.path) === codeKey(recorded.repoId, recorded.path)))) {
        return [diag('STALE_BASELINE', 'task scope contains files absent from the tested manifest')];
      }
    } catch (error) { return [diag('CAPABILITY_UNAVAILABLE', (error as Error).message)]; }
  }
  for (const row of receipt.codeManifest) {
    if (row.repoId !== repoId) return [diag('UNRESOLVED_REFERENCE', `receipt file belongs to another checkout: ${row.repoId}`)];
    const file = join(root, row.path);
    try { await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { codeHashes.set(codeKey(row.repoId, row.path), null); continue; }
      else return [diag('IO_ERROR', `cannot verify receipt file: ${row.path}`)];
    }
    try {
      const actual = await realpath(file);
      if (!isWithin(root, actual)) return [diag('PERMISSION_DENIED', `receipt file escapes checkout: ${row.path}`)];
      codeHashes.set(codeKey(row.repoId, row.path), sha256HexBytes(await readFile(actual)));
    } catch { return [diag('IO_ERROR', `cannot verify receipt file: ${row.path}`)]; }
  }
  return evaluateReceipt(receipt, {
    taskContractHash: contract, inputHashes, criterionHashes, codeHashes,
    acceptanceRefs: task?.meta.work?.acceptanceRefs ?? receipt.coverage.map(({ uri, criterionId }) => ({ uri, criterionId })),
    verification: task?.meta.work?.verification ?? [],
    implementor: receipt.actor,
  });
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
  acceptance: ['requirement', 'initiative'],
};

export async function collectTaskBaseline(root: string, taskRef: string): Promise<BaselineResult> {
  try { return await withAssetLock(root, () => collectBaseline(root, taskRef, new Set())); }
  catch (error) { return { ok: false, problems: [diag((error as { code?: Diagnostic['code'] }).code ?? 'IO_ERROR', (error as Error).message)] }; }
}

async function collectBaseline(root: string, taskRef: string, ancestors: ReadonlySet<string>): Promise<BaselineResult> {
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
  if (index.diagnostics.length) return { ok: false, problems: index.diagnostics };
  const uriOf = (id: string): string => noteUri(repoId, id);
  if (taskRef.startsWith('note://') && !taskRef.startsWith(`note://${repoId}/`)) {
    return { ok: false, problems: [diag('UNRESOLVED_REFERENCE', `task belongs to another checkout: ${taskRef}`)] };
  }
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
  if (ancestors.has(taskUri)) return { ok: false, problems: [diag('INVALID_RELATION', `receipt dependency cycle: ${taskUri}`)] };
  const visiting = new Set(ancestors).add(taskUri);
  // Each target has one digest. Multiple paths merge their criterion sets.
  const inputs: BaselineInput[] = [];
  const done = new Set<string>([taskUri]);

  const targetOf = (uri: string): { target: Target } | { missing: boolean } | { invalid: string } => {
    if (!uri.startsWith(`note://${repoId}/`)) return { missing: true };
    const entry = index.byId.get(tailId(uri));
    if (!entry) return { missing: true };
    if (!entry.note || entry.diagnostics.length > 0) return { invalid: entry.relPath };
    return { target: { uri: uriOf(entry.note.meta.id), note: entry.note } };
  };

  const required = new Set<string>();
  for (const ref of task.meta.work!.acceptanceRefs) {
    const resolved = targetOf(ref.uri);
    if (!('target' in resolved)) return { ok: false, problems: [diag('UNRESOLVED_REFERENCE', `unresolved acceptance target: ${ref.uri}`)] };
    const note = resolved.target.note;
    if (!note.acs.some((ac) => ac.id === ref.criterionId) || (ref.uri !== taskUri && !['requirement', 'initiative'].includes(note.meta.kind))) return { ok: false, problems: [diag('INVALID_RELATION', `invalid acceptance reference: ${ref.uri}#${ref.criterionId}`)] };
    if (note.meta.kind === 'requirement') required.add(`${ref.uri}#${ref.criterionId}`);
  }
  const intended = new Set((task.meta.relations ?? []).filter((rel) => rel.type === 'implements').flatMap((rel) => (rel.criteria ?? []).map((id) => `${rel.target}#${id}`)));
  if (required.size !== intended.size || [...required].some((key) => !intended.has(key))) return { ok: false, problems: [diag('INVALID_RELATION', 'implements criteria must match work.acceptanceRefs', 'work.acceptanceRefs')] };

  const pinTarget = async (uri: string, via: string, edgeCriteria: string[] | undefined, stack: string[]): Promise<void> => {
    if (stack.includes(uri)) {
      problems.push(diag('INVALID_RELATION', `dependency cycle: ${[...stack, uri].join(' -> ')}`));
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
    if (target.note.meta.lifecycle !== 'accepted' && !(kind === 'decision' && target.note.meta.lifecycle === 'implemented')) {
      problems.push(diag('NOT_READY', `execution input is not adopted: ${uri}`, 'lifecycle'));
      return;
    }
    // Implementing a requirement does not require it to be implemented
    // already. A dependency does, even if another edge pinned it first.
    if (kind === 'requirement' && via === 'depends-on') {
      const proof = await proveCoverage(root, repoId, target.uri, target.note, visiting);
      if (!proof.covered) {
        problems.push(diag('DEPENDENCY_UNSATISFIED', `requirement ${target.uri} has uncovered acceptance: ${proof.uncovered.join(', ') || 'no acceptance criteria'}`));
        return;
      }
    }
    const firstVisit = !done.has(uri);
    if (!firstVisit && kind !== 'requirement' && kind !== 'initiative') return;
    const lines = acLines(target.note);
    const existing = inputs.find((input) => input.uri === uri);
    const wanted = [...new Set([...(edgeCriteria?.length ? edgeCriteria : Object.keys(lines)), ...(existing?.criteria ?? [])])].sort();
    for (const id of edgeCriteria ?? []) {
      if (!(id in lines)) {
        problems.push(diag('INVALID_RELATION', `unknown criterion ${id} on ${uri}`));
        return;
      }
    }
    const criteria: Record<string, string> = {};
    for (const id of wanted) criteria[id] = lines[id];
    done.add(uri);

    if (kind === 'requirement' || kind === 'initiative') {
      const digest = contentDigest({
        uri: target.uri, kind, lifecycle: target.note.meta.lifecycle,
        sections: pickSections(target.note, kind), criteria,
      });
      const pin = { uri: target.uri, contentHash: digest.digest, criteria: Object.keys(criteria) };
      if (existing) Object.assign(existing, pin);
      else inputs.push(pin);
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
      if (execution.baseline.taskContractHash !== depContract) {
        problems.push(diag('STALE_BASELINE', `predecessor contract changed: ${target.uri}`));
        return;
      }
      let validReceipt = false;
      for (const id of execution.receipts) {
        if (typeof id !== 'string') continue;
        const found = await findReceiptBytes(root, id);
        if (!found) {
          problems.push(diag('UNRESOLVED_REFERENCE', `predecessor receipt not found: ${id} (via ${target.uri})`));
          return;
        }
        let receipt: Receipt;
        try { receipt = JSON.parse(Buffer.from(found.bytes).toString('utf8')) as Receipt; }
        catch { continue; }
        if (validateReceiptShape(receipt).length > 0 || receipt.id !== id || receipt.taskUri !== target.uri || receipt.mode !== execution.mode || receipt.attempt !== execution.attempt) continue;
        if ((await receiptProblems(root, repoId, receipt, visiting)).length > 0) continue;
        validReceipt = true;
        dependencies.push({ uri: target.uri, contractHash: depContract, receiptHash: receiptContentHash(receipt) });
      }
      if (!validReceipt) {
        problems.push(diag('DEPENDENCY_UNSATISFIED', `predecessor has no current passing receipt: ${target.uri}`));
        return;
      }
      const digest = contentDigest({
        uri: target.uri, kind, lifecycle: target.note.meta.lifecycle,
        sections: pickSections(target.note, kind), criteria,
        dependencies,
      });
      inputs.push({ uri: target.uri, contentHash: digest.digest, criteria: Object.keys(criteria) });
    }

    if (!firstVisit) return;
    if (kind === 'requirement' || kind === 'task' || kind === 'initiative') {
      for (const rel of target.note.meta.relations ?? []) {
        if (rel.type !== 'depends-on' && rel.type !== 'governed-by') continue;
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
  const inherited = new Map<string, string[]>();
  for (const ref of task.meta.work!.acceptanceRefs) {
    if (ref.uri !== taskUri) inherited.set(ref.uri, [...(inherited.get(ref.uri) ?? []), ref.criterionId]);
  }
  for (const [uri, criteria] of inherited) {
    await pinTarget(uri, 'acceptance', criteria, [taskUri]);
    if (problems.length > 0) return { ok: false, problems };
  }
  const sorted = [...inputs].sort((a, b) => (a.uri < b.uri ? -1 : 1));
  return { ok: true, baseline: { taskUri, taskContractHash: taskContractHash(task), inputs: sorted } };
}
