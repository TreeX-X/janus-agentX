/** S1 bundle reuse: the WorkFlowX candidate fixtures validate here unchanged. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNote, receiptContentHash, validateNote, validateReceiptShape } from '../src/index.js';

const GIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const STD = join(GIT, 'WorkFlowX', 'standards', 'harness-note', '1');
const PRESENT = existsSync(join(STD, 'manifest.json'));

describe.runIf(PRESENT)('S1 fixture reuse', () => {
  const manifest = JSON.parse(readFileSync(join(STD, 'manifest.json'), 'utf8'));
  it('pins portable receipt identity while preserving string and array semantics', () => {
    const fixture = JSON.parse(readFileSync(join(STD, 'fixtures', 'receipt-content-hash.json'), 'utf8'));
    expect(validateReceiptShape(fixture.receipt)).toEqual([]);
    expect(receiptContentHash(fixture.receipt)).toBe(fixture.expectedHash);
    const reversed = Object.fromEntries(Object.entries(fixture.receipt).reverse());
    expect(receiptContentHash(JSON.parse(JSON.stringify(reversed, null, 2).replace(/\n/g, '\r\n')))).toBe(fixture.expectedHash);
    const changed = structuredClone(fixture.receipt);
    changed.checks[0].summary = changed.checks[0].summary.replace('[x]', '[ ]');
    expect(receiptContentHash(changed)).not.toBe(fixture.expectedHash);
  });
  it('manifest lists files that exist', () => {
    for (const f of manifest.files as string[]) {
      expect(existsSync(join(STD, f)), f).toBe(true);
    }
  });
  for (const t of ['idea', 'initiative', 'requirement', 'decision', 'task']) {
    it(`template ${t}.md validates`, () => {
      const raw = readFileSync(join(STD, 'templates', `${t}.md`), 'utf8');
      expect(validateNote(parseNote(raw))).toEqual([]);
    });
  }
  for (const v of [
    'valid-idea',
    'valid-initiative',
    'valid-requirement',
    'valid-decision',
    'valid-decision-implemented',
    'valid-task',
  ]) {
    it(`fixture ${v}.md validates`, () => {
      const raw = readFileSync(join(STD, 'fixtures', `${v}.md`), 'utf8');
      expect(validateNote(parseNote(raw))).toEqual([]);
    });
  }
  for (const f of readdirSync(join(STD, 'fixtures')).filter((x) => x.startsWith('invalid-') && x.endsWith('.md'))) {
    it(`${f} fails with its expected code`, () => {
      const raw = readFileSync(join(STD, 'fixtures', f), 'utf8');
      const exp = JSON.parse(readFileSync(join(STD, 'fixtures', f.replace(/\.md$/, '.expected.json')), 'utf8'));
      let codes: string[] = [];
      try {
        codes = validateNote(parseNote(raw)).map((d) => d.code);
        if (codes.length === 0) codes = ['PASSED'];
      } catch (e) {
        codes = [(e as { code?: string }).code ?? '?'];
      }
      expect(codes).toContain(exp.code);
    });
  }
});
