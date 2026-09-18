/**
 * Transaction journal (contract C5). Before-snapshots plus metadata land
 * before any note byte moves; temp files carry the after bytes. Recovery
 * classifies every touched file as before/after/neither and only resumes
 * when nothing foreign appeared. Readers publish only fully settled scans.
 */
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256HexBytes } from './repository.js';

export const txDir = (root: string, txId: string): string => resolve(root, '.agents', '.local', 'transactions', txId);
export const opsDir = (root: string): string => resolve(root, '.agents', '.local', 'operations');

export interface JournalFile {
  operationId: string;
  relPath: string;
  existed: boolean;
  beforeHash: string | null;
  /** Null means the post-image is absent (delete). */
  afterHash: string | null;
  snapName: string | null;
  tmpName: string;
}

export interface Journal {
  id: string;
  changeSetId: string;
  revision: number;
  requestDigest: string;
  files: JournalFile[];
}

export interface CommittedOps {
  committed: true;
  results: Array<{ operationId: string; status: string; relPath?: string }>;
}

async function writeFlushed(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

export async function writeJournal(root: string, journal: Journal): Promise<void> {
  await mkdir(txDir(root, journal.id), { recursive: true });
  await writeFlushed(join(txDir(root, journal.id), 'journal.json'), JSON.stringify(journal, null, 2));
}

export async function readJournal(root: string, txId: string): Promise<Journal | null> {
  try {
    return JSON.parse(await readFile(join(txDir(root, txId), 'journal.json'), 'utf8')) as Journal;
  } catch {
    return null;
  }
}

export async function writeTxFile(root: string, txId: string, name: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(txDir(root, txId), { recursive: true });
  await writeFlushed(join(txDir(root, txId), name), bytes);
}

export async function readTxFile(root: string, txId: string, name: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(txDir(root, txId), name));
  } catch {
    return null;
  }
}

export async function markCommitted(root: string, txId: string, committed: CommittedOps): Promise<void> {
  await writeFile(join(txDir(root, txId), 'committed.json'), JSON.stringify(committed, null, 2), 'utf8');
}

export async function readCommitted(root: string, txId: string): Promise<CommittedOps | null> {
  try {
    return JSON.parse(await readFile(join(txDir(root, txId), 'committed.json'), 'utf8')) as CommittedOps;
  } catch {
    return null;
  }
}

export async function markRecoveryRequired(root: string, txId: string, reason: string): Promise<void> {
  await mkdir(txDir(root, txId), { recursive: true });
  await writeFile(join(txDir(root, txId), 'RECOVERY_REQUIRED'), reason, 'utf8');
}

export async function isRecoveryRequired(root: string, txId: string): Promise<string | null> {
  try {
    return await readFile(join(txDir(root, txId), 'RECOVERY_REQUIRED'), 'utf8');
  } catch {
    return null;
  }
}

export async function listPendingTx(root: string): Promise<string[]> {
  try {
    return await readdir(resolve(root, '.agents', '.local', 'transactions'));
  } catch {
    return [];
  }
}

export async function currentHash(root: string, relPath: string): Promise<string | null> {
  try {
    return sha256HexBytes(await readFile(resolve(root, relPath)));
  } catch {
    return null;
  }
}

export type FileClass = 'before' | 'after' | 'neither';

/** Classify one touched file against its journal row. Absent file hashes as null. */
export function classifyFile(current: string | null, row: JournalFile): FileClass {
  if (current === row.beforeHash) return 'before';
  if (current === row.afterHash) return 'after';
  return 'neither';
}

export async function finalizeRename(root: string, txId: string, tmpName: string, relPath: string): Promise<void> {
  await rename(join(txDir(root, txId), tmpName), resolve(root, relPath));
}
