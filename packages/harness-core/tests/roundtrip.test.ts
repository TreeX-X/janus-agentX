/** Round-trip: parse -> serialize -> parse stability, unknown fields kept. */
import { describe, expect, it } from 'vitest';
import { parseNote, serializeNote, validateNote } from '../src/index.js';

const RAW = [
  '---',
  'schema: harness-note/1',
  'id: 33333333-3333-4333-8333-333333333333',
  'kind: requirement',
  'lifecycle: proposed',
  'created: 2026-09-16',
  'class: feature',
  'tags: [blueprint]',
  'futureField: keep-me',
  'extensions:',
  '  workflowx:',
  '    provenance: roundtable',
  '---',
  '',
  '# Keep the title',
  '',
  '## Problem',
  '',
  'Text with `code` and 中文。',
  '',
  '## Expected behavior',
  '',
  'More.',
  '',
  '## Scope',
  '',
  'S.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] AC-1: One.',
  '',
].join('\n');

describe('round-trip', () => {
  it('preserves unknown fields, extensions, order, and body', () => {
    const once = parseNote(RAW);
    expect(once.unknownFields).toEqual({ futureField: 'keep-me' });
    expect(once.keyOrder[0]).toBe('schema');
    const twice = parseNote(serializeNote(once));
    expect(twice.meta).toEqual(once.meta);
    expect(twice.unknownFields).toEqual(once.unknownFields);
    expect(twice.title).toBe('Keep the title');
    expect(validateNote(twice)).toEqual([
      { code: 'SCHEMA_INVALID', message: `unknown top-level key 'futureField'`, path: 'futureField' },
    ]);
  });
  it('keeps CRLF and BOM bookkeeping', () => {
    const withBom = '﻿' + RAW.replace(/\n/g, '\r\n');
    const note = parseNote(withBom);
    expect(note.eol).toBe('\r\n');
    expect(note.bom).toBe(true);
    const out = serializeNote(note);
    expect(out.includes('\r\n')).toBe(true);
    expect(parseNote(out).title).toBe('Keep the title');
  });
});
