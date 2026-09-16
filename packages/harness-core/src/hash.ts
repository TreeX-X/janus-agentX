/**
 * Task contract and content hashing (contract C3 + C107 top-up).
 * The canonical form below is byte-locked by the S1 fixture
 * (taskContractHash 73e31550…); S2 ports it verbatim and only adds
 * the input/criterion digests the S1 checker left as placeholders.
 */
import { createHash } from 'node:crypto';
import { canon, contractSections } from './serialize.js';
import type { ParsedNote } from './schema.js';
import { CONTRACT_RELATIONS } from './schema.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Raw-byte file digest used for expectedHash / optimistic concurrency (C5). */
export function fileHash(bytes: Uint8Array | string): string {
  return sha256Hex(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
}

export interface TaskContractInput {
  schema: string;
  id: string;
  kind: string;
  title: string;
  repositories?: unknown;
  relations: Array<{ type: string; target: string; criteria?: string[] }>;
  work?: {
    scope: Array<{ repoId: string; paths: string[] }>;
    acceptanceRefs: Array<{ uri: string; criterionId: string }>;
    verification: unknown[];
  };
  sections: Record<string, string>;
}

/** Build the hashed contract input from a parsed task note. */
export function taskContractInput(note: ParsedNote): TaskContractInput {
  const m = note.meta;
  const rels = (m.relations ?? [])
    .filter((r) => (CONTRACT_RELATIONS as readonly string[]).includes(r.type))
    .map((r) => ({ type: r.type, target: r.target, criteria: [...(r.criteria ?? [])].sort() }))
    .sort((a, b) => (canon(a) < canon(b) ? -1 : 1));
  const work = m.work
    ? {
        scope: [...m.work.scope]
          .sort((a, b) => String(a.repoId).localeCompare(String(b.repoId)))
          .map((s) => ({ repoId: String(s.repoId), paths: [...s.paths].sort() })),
        acceptanceRefs: [...m.work.acceptanceRefs].sort((a, b) =>
          `${a.uri}${a.criterionId}`.localeCompare(`${b.uri}${b.criterionId}`),
        ),
        verification: m.work.verification as unknown[],
      }
    : undefined;
  const input: TaskContractInput = {
    schema: m.schema,
    id: m.id,
    kind: m.kind,
    title: note.title,
    repositories: m.repositories,
    relations: rels,
    work,
    sections: contractSections(note),
  };
  if (input.repositories === undefined) delete input.repositories;
  if (input.work === undefined) delete input.work;
  return input;
}

/** The version pin: writing execution/Results never moves it, scope moves do. */
export function taskContractHash(note: ParsedNote): string {
  return sha256Hex(Buffer.from(canon(taskContractInput(note)), 'utf8'));
}

/** Stable AC line digest (checkbox normalized, C3). */
export function criterionHash(acLine: string): string {
  const norm = acLine.replace(/\r\n/g, '\n').replace(/- \[(x|X)\]/, '- [ ]');
  return sha256Hex(Buffer.from(norm, 'utf8'));
}

export interface ContentInputDigest {
  uri: string;
  kind: string;
  lifecycle: string;
  digest: string;
}

/**
 * Requirement/decision/task input digest for baseline pinning (C3):
 * lifecycle plus the normative sections and referenced criteria.
 */
export function contentDigest(input: {
  uri: string;
  kind: string;
  lifecycle: string;
  sections: Record<string, string>;
  criteria?: Record<string, string>;
  dependencies?: Array<{ uri: string; contractHash: string; receiptHash: string }>;
}): ContentInputDigest {
  const criteria: Record<string, string> = {};
  for (const [id, line] of Object.entries(input.criteria ?? {})) criteria[id] = criterionHash(line);
  const canonical = {
    uri: input.uri,
    kind: input.kind,
    lifecycle: input.lifecycle,
    sections: input.sections,
    criteria,
    dependencies: [...(input.dependencies ?? [])].sort((a, b) =>
      `${a.uri}${a.contractHash}${a.receiptHash}`.localeCompare(`${b.uri}${b.contractHash}${b.receiptHash}`),
    ),
  };
  return { uri: input.uri, kind: input.kind, lifecycle: input.lifecycle, digest: sha256Hex(Buffer.from(canon(canonical), 'utf8')) };
}
