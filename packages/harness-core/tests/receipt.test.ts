/** Receipt shape and effective validity (C4, F06 subset). */
import { describe, expect, it } from 'vitest';
import { coverageRatio, codeKey, codeManifestHash, evaluateReceipt, validateReceiptShape, type Receipt } from '../src/index.js';

const R = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const CONTRACT = '73e315502bb2e0678461ba859f4d16d73c101bdd55d2c167ecbee36eae1b8ae6';
const TASK = `note://${R}/55555555-5555-4555-8555-555555555555`;
const REQ = `note://${R}/33333333-3333-4333-8333-333333333333`;

function receipt(over: Partial<Receipt> = {}): Receipt {
  const manifest = over.codeManifest ?? [{ repoId: R, path: 'src/a.ts', sha256: 'b'.repeat(64) }];
  return {
    schema: 'harness-receipt/1',
    id: 'r1',
    taskUri: TASK,
    mode: 'xdo',
    attempt: 1,
    taskContractHash: CONTRACT,
    inputs: [{ uri: REQ, contentHash: 'a'.repeat(64), criteria: ['AC-1'] }],
    codeManifest: manifest,
    checks: [{ id: 'V-1', kind: 'command', required: true, status: 'passed', repoId: R, command: { program: 'node', args: ['--test'], cwd: '.' }, exitCode: 0, summary: 'ok', performedBy: 'cli' }],
    coverage: [{ uri: REQ, criterionId: 'AC-1', criterionHash: 'c'.repeat(64), checkIds: ['V-1'] }],
    review: { kind: 'self', verdict: 'approved', reviewedManifestHash: codeManifestHash(manifest), actor: 'cli' },
    createdAt: '2026-09-16T00:00:00Z',
    actor: 'cli',
    ...over,
  };
}

const liveCtx = () => ({
  taskContractHash: CONTRACT,
  inputHashes: new Map([[REQ, 'a'.repeat(64)]]),
  criterionHashes: new Map([[REQ, new Map([['AC-1', 'c'.repeat(64)]])]]),
  codeHashes: new Map([[codeKey(R, 'src/a.ts'), 'b'.repeat(64)]]),
  acceptanceRefs: [{ uri: REQ, criterionId: 'AC-1' }],
  verification: [{ id: 'V-1', kind: 'command' as const, required: true, repoId: R, cwd: '.', program: 'node', args: ['--test'] }],
  implementor: 'cli',
});

describe('receipt', () => {
  it('accepts a well-formed receipt', () => {
    expect(validateReceiptShape(receipt())).toEqual([]);
    expect(evaluateReceipt(receipt(), liveCtx())).toEqual([]);
  });
  it('rejects xflow self-review as a stand-in for independent review', () => {
    const r = receipt({ mode: 'xflow' });
    expect(validateReceiptShape(r).some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    const indep = receipt({
      mode: 'xflow',
      review: { ...receipt().review, kind: 'independent', actor: 'reviewer' },
    });
    expect(validateReceiptShape(indep)).toEqual([]);
    expect(evaluateReceipt(indep, { ...liveCtx(), implementor: 'builder' })).toEqual([]);
  });
  it('expires on contract, input, criterion, or code drift', () => {
    expect(
      evaluateReceipt(receipt(), { ...liveCtx(), taskContractHash: '0'.repeat(64) }).some(
        (d) => d.code === 'STALE_BASELINE',
      ),
    ).toBe(true);
    expect(
      evaluateReceipt(receipt(), { ...liveCtx(), inputHashes: new Map([[REQ, 'f'.repeat(64)]]) }).some(
        (d) => d.code === 'STALE_BASELINE',
      ),
    ).toBe(true);
    expect(
      evaluateReceipt(receipt(), {
        ...liveCtx(),
        codeHashes: new Map([[codeKey(R, 'src/a.ts'), '9'.repeat(64)]]),
      }).some((d) => d.code === 'STALE_BASELINE'),
    ).toBe(true);
    const failed = receipt({
      checks: [{ id: 'V-1', kind: 'command', required: true, status: 'failed', repoId: R, exitCode: 1, summary: 'no', performedBy: 'cli' }],
    });
    expect(evaluateReceipt(failed, liveCtx()).some((d) => d.code === 'NOT_READY')).toBe(true);
  });
  it('never averages an empty required set to complete', () => {
    expect(coverageRatio(0, 0)).toBeUndefined();
    expect(coverageRatio(1, 2)).toBe(0.5);
  });

  it('binds review to every manifest row regardless of ordering', () => {
    const r = receipt();
    r.review.reviewedManifestHash = 'd'.repeat(64);
    expect(evaluateReceipt(r, liveCtx()).some((problem) => problem.path === 'review.reviewedManifestHash')).toBe(true);
    const manifest = [...r.codeManifest, { repoId: R, path: 'deleted.ts', deleted: true }];
    expect(codeManifestHash(manifest)).toBe(codeManifestHash([...manifest].reverse()));
    expect(codeManifestHash(manifest)).not.toBe(codeManifestHash(r.codeManifest));
  });

  it('rejects malformed nested values without throwing', () => {
    for (const field of ['inputs', 'codeManifest', 'checks', 'coverage']) {
      for (const value of [undefined, null, {}, [null], [1]]) {
        expect(validateReceiptShape({ ...receipt(), [field]: value }), `${field}: ${JSON.stringify(value)}`).not.toEqual([]);
      }
    }
    expect(validateReceiptShape({ ...receipt(), review: null })).not.toEqual([]);
  });

  it('requires live evidence for every input, criterion, and file', () => {
    for (const patch of [
      { inputHashes: new Map() },
      { criterionHashes: new Map() },
      { codeHashes: new Map() },
    ]) {
      expect(evaluateReceipt(receipt(), { ...liveCtx(), ...patch }).some((d) => d.code === 'STALE_BASELINE')).toBe(true);
    }
    expect(evaluateReceipt(receipt({ inputs: [] }), liveCtx())).not.toEqual([]);
    expect(evaluateReceipt(receipt({ coverage: [] }), liveCtx())).not.toEqual([]);
  });

  it('cannot omit or downgrade a required check from the task contract', () => {
    const optional = receipt({ checks: [{ ...receipt().checks[0], required: false }] });
    expect(evaluateReceipt(optional, liveCtx())).not.toEqual([]);
    const other = receipt({
      checks: [{ ...receipt().checks[0], id: 'different' }],
      coverage: [{ ...receipt().coverage[0], checkIds: ['different'] }],
    });
    expect(evaluateReceipt(other, liveCtx())).not.toEqual([]);
  });

  it('accepts a failed independent review as evidence but never as completion', () => {
    for (const verdict of ['needs-fix', 'blocked'] as const) {
      const r = receipt({ mode: 'xflow', review: { ...receipt().review, kind: 'independent', actor: 'reviewer', verdict } });
      expect(validateReceiptShape(r)).toEqual([]);
      expect(evaluateReceipt(r, liveCtx()).some((d) => d.code === 'NOT_READY')).toBe(true);
    }
    expect(evaluateReceipt(receipt({ review: { ...receipt().review, verdict: 'needs-fix' } }), liveCtx())).not.toEqual([]);
  });

  it('requires explicit confirmation that a deleted file is absent', () => {
    const r = receipt({ codeManifest: [{ repoId: R, path: 'src/a.ts', deleted: true }] });
    expect(evaluateReceipt(r, liveCtx())).not.toEqual([]);
    expect(evaluateReceipt(r, { ...liveCtx(), codeHashes: new Map() })).not.toEqual([]);
    expect(evaluateReceipt(r, { ...liveCtx(), codeHashes: new Map([[codeKey(R, 'src/a.ts'), null]]) })).toEqual([]);
  });

  it('rejects ambiguous manifests, duplicate check ids, and unknown check results', () => {
    const manifest = receipt().codeManifest;
    expect(validateReceiptShape(receipt({ codeManifest: [...manifest, ...manifest] }))).not.toEqual([]);
    expect(validateReceiptShape(receipt({ codeManifest: [{ ...manifest[0], deleted: true }] }))).not.toEqual([]);
    expect(validateReceiptShape(receipt({ codeManifest: [{ repoId: R, path: '../outside', sha256: 'b'.repeat(64) }] }))).not.toEqual([]);
    expect(validateReceiptShape(receipt({ checks: [...receipt().checks, ...receipt().checks] }))).not.toEqual([]);
    expect(validateReceiptShape({ ...receipt(), checks: [{ ...receipt().checks[0], status: 'yes' }] })).not.toEqual([]);
  });
});
