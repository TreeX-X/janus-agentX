/**
 * Managed multi-file apply (contract C5). One checkout serializes short
 * persistence under `.local/locks/notes.lock`; the journal under
 * `.local/transactions/` makes every crash resumable or explicitly
 * blocked. Idempotent retries share one key:
 * changeSet.id/revision/operationId plus the caller request digest.
 * Test-only crash injection lives behind `opts.inject` (F04).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  parseNote,
  validateChangeSet,
  validateNote,
  type Diagnostic,
  type ParsedNote,
} from '@janus-agent/harness-core';
import {
  buildNoteIndex,
  noteFileName,
  sha256HexBytes,
  type NoteIndex,
} from './repository.js';
import {
  classifyFile,
  currentHash,
  finalizeRename,
  isRecoveryRequired,
  listPendingTx,
  markCommitted,
  markRecoveryRequired,
  opsDir,
  readCommitted,
  readJournal,
  readTxFile,
  txDir,
  writeJournal,
  writeTxFile,
  type CommittedOps,
  type Journal,
} from './journal.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

const lockFile = (root: string): string => resolve(root, '.agents', '.local', 'locks', 'notes.lock');

interface LockBody {
  host: string;
  pid: number;
  startToken: string;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLock(root: string, opts: { force?: boolean } = {}): Promise<LockBody> {
  await mkdir(dirname(lockFile(root)), { recursive: true });
  const body: LockBody = { host: hostname(), pid: process.pid, startToken: randomUUID(), at: new Date().toISOString() };
  try {
    await writeFile(lockFile(root), JSON.stringify(body), { flag: 'wx', encoding: 'utf8' });
    return body;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (opts.force) {
    await rm(lockFile(root), { force: true });
    return acquireLock(root);
  }
  try {
    const prev = JSON.parse(await readFile(lockFile(root), 'utf8')) as LockBody;
    if (prev.host === body.host && typeof prev.pid === 'number' && !pidAlive(prev.pid)) {
      await rm(lockFile(root), { force: true });
      return acquireLock(root);
    }
  } catch {
    throw Object.assign(new Error('notes busy: lock held'), { code: 'BUSY' });
  }
  throw Object.assign(new Error('notes busy: lock held'), { code: 'BUSY' });
}

export async function releaseLock(root: string, mine: LockBody): Promise<void> {
  try {
    const cur = JSON.parse(await readFile(lockFile(root), 'utf8')) as LockBody;
    if (cur.startToken === mine.startToken) await rm(lockFile(root), { force: true });
  } catch {
    // Best effort; a recovered peer owns the file now.
  }
}

export interface CrashInject {
  failAfter?: 'journal' | 'temp' | number;
}

const crash = (stage: string): Error =>
  Object.assign(new Error(`injected crash ${stage}`), { code: 'IO_ERROR', injected: true });

export interface RecoverReport {
  resumed: string[];
  completed: string[];
  blocked: Array<{ txId: string; reason: string }>;
}

/** Resume or park every unfinished transaction. Never invents after-bytes. */
export async function recoverPending(root: string): Promise<RecoverReport> {
  const report: RecoverReport = { resumed: [], completed: [], blocked: [] };
  for (const txId of await listPendingTx(root)) {
    if (await readCommitted(root, txId)) continue;
    const marker = await isRecoveryRequired(root, txId);
    if (marker !== null) {
      report.blocked.push({ txId, reason: marker });
      continue;
    }
    const journal = await readJournal(root, txId);
    if (!journal) continue; // Crashed before any note byte could move.
    const classes = new Map<string, 'before' | 'after' | 'neither'>();
    for (const row of journal.files) {
      classes.set(row.relPath, classifyFile(await currentHash(root, row.relPath), row));
    }
    const values = [...classes.values()];
    if (values.some((c) => c === 'neither')) {
      const reason = 'foreign bytes appeared mid-transaction; refusing to overwrite';
      await markRecoveryRequired(root, txId, reason);
      report.blocked.push({ txId, reason });
      continue;
    }
    const needApply = journal.files.filter((f) => classes.get(f.relPath) === 'before');
    const tmpsPresent = async (): Promise<boolean> => {
      for (const row of needApply) {
        if (row.afterHash === null) continue; // delete needs no tmp
        if ((await readTxFile(root, txId, row.tmpName)) === null) return false;
      }
      return true;
    };
    if (!(await tmpsPresent())) {
      if (needApply.length === journal.files.length) {
        // Crashed before any note byte moved and the after-bytes died with
        // the process: drop the dead journal so re-issuing works. Nothing applied.
        await rm(txDir(root, txId), { recursive: true, force: true });
        report.resumed.push(txId);
        continue;
      }
      const reason = 'after-bytes lost with the crashed process; re-issue the change set';
      await markRecoveryRequired(root, txId, reason);
      report.blocked.push({ txId, reason });
      continue;
    }
    for (const row of needApply) {
      if (row.afterHash === null) {
        await rm(resolve(root, row.relPath), { force: true });
      } else {
        await finalizeRename(root, txId, row.tmpName, row.relPath);
      }
    }
    const results = journal.files.map((f) => ({ operationId: f.operationId, status: 'applied' }));
    await markCommitted(root, txId, { committed: true, results });
    for (const f of journal.files) {
      await storeOpResult(root, journal.changeSetId, journal.revision, f.operationId, journal.requestDigest, {
        operationId: f.operationId,
        status: 'applied',
        relPath: f.relPath,
        errors: [],
      });
    }
    report.resumed.push(txId);
    report.completed.push(txId);
  }
  return report;
}

export interface ApplyOpts {
  selection?: string[];
  allowDelete?: boolean;
  requestDigest?: string;
  inject?: CrashInject;
  repoId?: string;
  onEvent?: (event: { type: string; txId: string; operationId?: string }) => void;
}

export interface OpOutcome {
  operationId: string;
  status: 'applied' | 'conflict' | 'invalid' | 'denied';
  relPath?: string;
  errors: Diagnostic[];
}

export interface ApplyReport {
  ok: boolean;
  txId: string;
  results: OpOutcome[];
  errors: Diagnostic[];
  recoveredStaleLock?: boolean;
}

const opResultFile = (root: string, csId: string, rev: number, opId: string): string =>
  join(opsDir(root), `${csId}-r${rev}-${opId}.json`);

interface StoredOp {
  requestDigest?: string;
  outcome: OpOutcome;
}

async function readStoredOp(root: string, csId: string, rev: number, opId: string): Promise<StoredOp | null> {
  try {
    return JSON.parse(await readFile(opResultFile(root, csId, rev, opId), 'utf8')) as StoredOp;
  } catch {
    return null;
  }
}

export interface ChangeSource {
  type: 'roundtable' | 'chat' | 'harness' | 'manual';
  id: string;
  revision: number;
}

export interface ApplyChangeSetInput {
  id: string;
  revision: number;
  source: ChangeSource;
  operations: PlannedOp[];
}

export interface PlannedOp {
  operationId: string;
  type: 'create' | 'replace' | 'delete';
  uri: string;
  expectedHash: string | null;
  relativePath?: string;
  afterMarkdown?: string;
  dependsOn: string[];
  note?: ParsedNote;
  noteDiagnostics: Diagnostic[];
  targetRel?: string;
}

function idPart(uri: string): string {
  return uri.split('/').pop() ?? uri;
}

export async function applyChangeSet(
  root: string,
  cs: ApplyChangeSetInput,
  opts: ApplyOpts = {},
): Promise<ApplyReport> {
  const shapeErrors = validateChangeSet(cs);
  if (shapeErrors.length > 0) {
    return { ok: false, txId: '', results: [], errors: shapeErrors };
  }
  const txId = `${cs.id}-r${cs.revision}`;
  let mine: LockBody;
  try {
    mine = await acquireLock(root);
  } catch (e) {
    const code = (e as { code?: Diagnostic['code'] }).code ?? 'BUSY';
    return { ok: false, txId, results: [], errors: [diag(code, (e as Error).message)] };
  }
  try {
    return await applyLocked(root, cs, txId, opts);
  } finally {
    await releaseLock(root, mine);
  }
}

async function applyLocked(
  root: string,
  cs: ApplyChangeSetInput,
  txId: string,
  opts: ApplyOpts,
): Promise<ApplyReport> {
  const recovery = await recoverPending(root);
  if (recovery.blocked.length > 0) {
    return {
      ok: false,
      txId,
      results: [],
      errors: recovery.blocked.map((b) => diag('RECOVERY_REQUIRED', `transaction ${b.txId}: ${b.reason}`)),
    };
  }
  if (await readCommitted(root, txId)) {
    // Same key already landed. Same digest replays the stored outcomes;
    // a different digest re-issues the key and reports CONFLICT (C5).
    const results: OpOutcome[] = [];
    for (const op of cs.operations) {
      const stored = await readStoredOp(root, cs.id, cs.revision, op.operationId);
      if (!stored || stored.requestDigest !== opts.requestDigest) {
        return {
          ok: false,
          txId,
          results: [],
          errors: [diag('CONFLICT', `key ${txId}/${op.operationId} already landed under another request`)],
        };
      }
      results.push(stored.outcome);
    }
    return { ok: true, txId, results, errors: [] };
  }
  // Selection closure over dependsOn.
  const byOp = new Map(cs.operations.map((o) => [o.operationId, o]));
  let planned = cs.operations;
  if (opts.selection) {
    const keep = new Set<string>();
    const visit = (id: string): void => {
      if (keep.has(id)) return;
      const op = byOp.get(id);
      if (!op) return;
      keep.add(id);
      for (const d of op.dependsOn) visit(d);
    };
    for (const id of opts.selection) {
      if (!byOp.has(id)) {
        return { ok: false, txId, results: [], errors: [diag('SCHEMA_INVALID', `unknown selected operation ${id}`)] };
      }
      visit(id);
    }
    planned = cs.operations.filter((o) => keep.has(o.operationId));
  }
  const index: NoteIndex = await buildNoteIndex(root);
  const taken = new Set(index.entries.map((e) => e.relPath.toLowerCase()));
  // Plan + validate every operation before touching bytes.
  for (const op of planned) {
    op.noteDiagnostics = [];
    if (op.type === 'delete' && !opts.allowDelete) {
      op.noteDiagnostics.push(diag('APPROVAL_REQUIRED', `delete needs explicit grant: ${op.uri}`, op.operationId));
      continue;
    }
    const stored = await readStoredOp(root, cs.id, cs.revision, op.operationId);
    if (stored && stored.requestDigest === opts.requestDigest) continue; // replay below
    if (stored && stored.requestDigest !== opts.requestDigest) {
      op.noteDiagnostics.push(diag('CONFLICT', `operation retried with a different request: ${op.operationId}`, op.operationId));
      continue;
    }
    const id = idPart(op.uri);
    if (op.type === 'create') {
      if (index.byId.has(id)) {
        op.noteDiagnostics.push(diag('CONFLICT', `note id already exists: ${id}`, op.operationId));
        continue;
      }
      if (!op.afterMarkdown) {
        op.noteDiagnostics.push(diag('SCHEMA_INVALID', 'create needs afterMarkdown', op.operationId));
        continue;
      }
      try {
        op.note = parseNote(op.afterMarkdown);
      } catch (e) {
        op.noteDiagnostics.push(
          diag((e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID', (e as Error).message, op.operationId),
        );
        continue;
      }
      op.noteDiagnostics.push(...validateNote(op.note));
      const rel = op.relativePath ?? autoRel(taken, op.note);
      if (index.entries.some((e) => e.relPath.toLowerCase() === `.agents/notes/${rel}`.toLowerCase())) {
        op.noteDiagnostics.push(diag('CONFLICT', `target file exists: ${rel}`, op.operationId));
        continue;
      }
      op.targetRel = `.agents/notes/${rel}`;
    } else {
      const entry = index.byId.get(id);
      if (!entry) {
        op.noteDiagnostics.push(diag('NOT_FOUND', `unknown note: ${op.uri}`, op.operationId));
        continue;
      }
      op.targetRel = entry.relPath;
      const current = await currentHash(root, entry.relPath);
      if (current !== op.expectedHash) {
        op.noteDiagnostics.push(diag('CONFLICT', `stale expectedHash for ${entry.relPath}`, op.operationId));
        continue;
      }
      if (op.type === 'replace') {
        if (!op.afterMarkdown) {
          op.noteDiagnostics.push(diag('SCHEMA_INVALID', 'replace needs afterMarkdown', op.operationId));
          continue;
        }
        try {
          op.note = parseNote(op.afterMarkdown);
        } catch (e) {
          op.noteDiagnostics.push(
            diag((e as { code?: Diagnostic['code'] }).code ?? 'SCHEMA_INVALID', (e as Error).message, op.operationId),
          );
          continue;
        }
        if (op.note.meta.id !== id) {
          op.noteDiagnostics.push(diag('SCHEMA_INVALID', 'replace must keep note identity', op.operationId));
          continue;
        }
        if (op.relativePath) {
          const dest = `.agents/notes/${op.relativePath}`;
          if (dest !== entry.relPath && index.entries.some((e) => e.relPath.toLowerCase() === dest.toLowerCase())) {
            op.noteDiagnostics.push(diag('CONFLICT', `rename target exists: ${dest}`, op.operationId));
            continue;
          }
          op.targetRel = dest;
        }
        op.noteDiagnostics.push(...validateNote(op.note));
      }
    }
  }
  // Final-graph loop check over the post-image (id graph; needs no repo binding).
  const loopErrors = checkPostImage(index, planned);
  const invalid = planned.filter((o) => o.noteDiagnostics.length > 0);
  if (invalid.length > 0 || loopErrors.length > 0) {
    return {
      ok: false,
      txId,
      results: planned.map((o) => ({
        operationId: o.operationId,
        status: o.noteDiagnostics.length > 0 ? ('invalid' as const) : ('denied' as const),
        errors: o.noteDiagnostics,
      })),
      errors: [...invalid.flatMap((o) => o.noteDiagnostics), ...loopErrors],
    };
  }
  // Journal, then temp files, then renames.
  const journal: Journal = { id: txId, changeSetId: cs.id, revision: cs.revision, requestDigest: opts.requestDigest ?? '', files: [] };
  for (const [i, op] of planned.entries()) {
    const rel = op.targetRel as string;
    const before = await currentHash(root, rel);
    const afterText = op.type === 'delete' ? null : (op.afterMarkdown as string);
    journal.files.push({
      operationId: op.operationId,
      relPath: rel,
      existed: before !== null,
      beforeHash: before,
      afterHash: afterText === null ? null : sha256HexBytes(Buffer.from(afterText, 'utf8')),
      snapName: before === null ? null : `snap-${i}`,
      tmpName: `tmp-${i}`,
    });
    if (before !== null) {
      await writeTxFile(root, txId, `snap-${i}`, await readFile(resolve(root, rel)));
    }
  }
  await writeJournal(root, journal);
  if (opts.inject?.failAfter === 'journal') throw crash('after journal');
  for (const [i, op] of planned.entries()) {
    if (op.type === 'delete') continue;
    await writeTxFile(root, txId, `tmp-${i}`, Buffer.from(op.afterMarkdown as string, 'utf8'));
  }
  if (opts.inject?.failAfter === 'temp') throw crash('after temp files');
  const results: OpOutcome[] = [];
  for (const [i, op] of planned.entries()) {
    const row = journal.files[i];
    if (op.type === 'delete') {
      try {
        await rm(resolve(root, row.relPath));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    } else {
      await mkdirSafe(dirname(resolve(root, row.relPath)));
      await finalizeRename(root, txId, row.tmpName, row.relPath);
      // A rename leaves the old path behind.
      const oldEntry = op.type === 'replace' ? index.byId.get(idPart(op.uri)) : undefined;
      if (op.type === 'replace' && oldEntry && oldEntry.relPath !== row.relPath) {
        await rm(resolve(root, oldEntry.relPath), { force: true });
      }
    }
    const outcome: OpOutcome = { operationId: op.operationId, status: 'applied', relPath: row.relPath, errors: [] };
    results.push(outcome);
    await storeOpResult(root, cs.id, cs.revision, op.operationId, opts.requestDigest, outcome);
    opts.onEvent?.({ type: 'artifact.applied', txId, operationId: op.operationId });
    if (opts.inject?.failAfter === i) throw crash(`after op ${i}`);
  }
  await markCommitted(root, txId, { committed: true, results: results.map((r) => ({ operationId: r.operationId, status: r.status, relPath: r.relPath })) });
  opts.onEvent?.({ type: 'run.finished', txId });
  return { ok: true, txId, results, errors: [] };
}

function autoRel(takenFull: Set<string>, note: ParsedNote): string {
  const bareTaken = new Set<string>();
  for (const p of takenFull) bareTaken.add(p.split('/').pop() ?? p);
  const name = noteFileName(note.meta.created, note.title, note.meta.id, bareTaken);
  takenFull.add(`.agents/notes/${name}`.toLowerCase());
  return name;
}

async function mkdirSafe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function storeOpResult(
  root: string,
  csId: string,
  rev: number,
  opId: string,
  requestDigest: string | undefined,
  outcome: OpOutcome,
): Promise<void> {
  await mkdir(dirname(join(opsDir(root), 'x')), { recursive: true });
  await writeFile(join(opsDir(root), `${csId}-r${rev}-${opId}.json`), JSON.stringify({ requestDigest, outcome }, null, 2), 'utf8');
}

/** Id-graph loop check on the post-image. Relation targets reduce to id parts. */
function checkPostImage(index: NoteIndex, planned: PlannedOp[]): Diagnostic[] {
  const nodes = new Map<string, { parent?: string; relations: Array<{ type: string; target: string }> }>();
  for (const e of index.entries) {
    if (!e.note) continue;
    nodes.set(e.note.meta.id, {
      parent: e.note.meta.parent ? idPart(e.note.meta.parent) : undefined,
      relations: (e.note.meta.relations ?? []).map((r) => ({ type: r.type, target: idPart(r.target) })),
    });
  }
  for (const op of planned) {
    const id = idPart(op.uri);
    if (op.type === 'delete') {
      nodes.delete(id);
    } else if (op.note) {
      nodes.set(id, {
        parent: op.note.meta.parent ? idPart(op.note.meta.parent) : undefined,
        relations: (op.note.meta.relations ?? []).map((r) => ({ type: r.type, target: idPart(r.target) })),
      });
    }
  }
  const out: Diagnostic[] = [];
  for (const type of ['parent', 'depends-on', 'derived-from', 'supersedes'] as const) {
    const color = new Map<string, number>();
    let loop: string[] | null = null;
    const edges = (id: string): string[] => {
      const n = nodes.get(id);
      if (!n) return [];
      if (type === 'parent') return n.parent && nodes.has(n.parent) ? [n.parent] : [];
      return n.relations.filter((r) => r.type === type).map((r) => r.target).filter((t) => nodes.has(t));
    };
    const visit = (id: string, stack: string[]): void => {
      if (loop) return;
      color.set(id, 1);
      stack.push(id);
      for (const next of edges(id)) {
        const c = color.get(next) ?? 0;
        if (c === 0) visit(next, stack);
        else if (c === 1) {
          loop = [...stack.slice(stack.indexOf(next)), next];
          return;
        }
      }
      stack.pop();
      color.set(id, 2);
    };
    for (const id of nodes.keys()) {
      if ((color.get(id) ?? 0) === 0) visit(id, []);
      if (loop) break;
    }
    if (loop) out.push({ code: 'INVALID_RELATION', message: `${type} cycle: ${(loop as string[]).join(' -> ')}` });
  }
  return out;
}
