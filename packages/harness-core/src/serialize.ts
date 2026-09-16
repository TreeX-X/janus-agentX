/**
 * Deterministic serialization and canonical JSON (contract C1/C3).
 * Frontmatter regenerates from parsed meta in original key order with
 * unknown fields preserved. Body stays verbatim. Byte-preserving partial
 * edits belong to the file repository (S3); this module only guarantees
 * parse -> serialize -> parse stability.
 */
import { Document, isMap } from 'yaml';
import type { ParsedNode } from 'yaml';
import { sliceSections } from './parse.js';
import type { ParsedNote } from './schema.js';

export function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

/** Recursive key-sorted canonical form. Arrays keep order except where callers pre-sort. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  if (typeof v === 'string') return JSON.stringify(v.replace(/\r\n/g, '\n').replace(/- \[(x|X)\]/g, '- [ ]'));
  return JSON.stringify(v);
}

function toYamlNode(doc: Document<ParsedNode>, value: unknown): ParsedNode {
  return doc.createNode(value) as ParsedNode;
}

/** Regenerate the full note text. Meta writes in original key order; new keys append. */
export function serializeNote(note: ParsedNote): string {
  const doc = new Document<ParsedNode>();
  const seen = new Set<string>();
  const put = (key: string, value: unknown): void => {
    if (!isMap(doc.contents)) return;
    doc.contents.items.push(doc.createPair(key, toYamlNode(doc, value)) as never);
    seen.add(key);
  };
  doc.contents = doc.createNode({}) as never;
  const meta = note.meta as unknown as Record<string, unknown>;
  for (const key of note.keyOrder) {
    if (key in meta) put(key, meta[key]);
    else if (key in note.unknownFields) put(key, note.unknownFields[key]);
  }
  for (const key of Object.keys(meta)) {
    if (key === 'schema' && seen.has('schema')) continue;
    if (!seen.has(key) && meta[key] !== undefined) put(key, meta[key]);
  }
  for (const key of Object.keys(note.unknownFields)) {
    if (!seen.has(key)) put(key, note.unknownFields[key]);
  }
  const fm = String(doc).replace(/\n$/, '');
  const head = `${note.bom ? '﻿' : ''}---\n${fm}\n---\n`;
  return normalizeEol(head, note.eol) + normalizeEol(note.body.replace(/^\n/, ''), note.eol);
}

/** Contract-section slices for hashing (fixed English names, line-based). */
export function contractSections(note: ParsedNote): Record<string, string> {
  const bodyLf = note.body.replace(/\r\n/g, '\n');
  return sliceSections(bodyLf, ['Scope', 'Acceptance criteria', 'Verification']);
}
