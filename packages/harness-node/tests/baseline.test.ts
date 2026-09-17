/**
 * Task baseline collection: contract pin, related-note digests, coverage
 * proof, predecessor receipts, and refusal taxonomy. Temp checkouts only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { criterionHash } from '@janus-agent/harness-core';
import { collectTaskBaseline, proveRequirementCoverage } from '../src/baseline.js';
import { buildNoteIndex } from '../src/repository.js';
import { makeRepo, REPO } from './helpers.js';

const REQ = '11111111-1111-4111-8111-111111111111';
const DEC = '33333333-3333-4333-8333-333333333333';
const DEP = '44444444-4444-4333-8333-444444444444';
const MAIN = '55555555-5555-4333-8333-555555555555';
const REQ_URI = `note://${REPO}/${REQ}`;

const acLine = (id: string, text: string): string => `- [ ] ${id}: ${text}`;

function requirement(id = REQ, extraAc = ''): string {
  return [
    '---', 'schema: harness-note/1', `id: ${id}`, 'kind: requirement',
    'lifecycle: accepted', 'created: 2026-09-17', '---', '',
    '# Requirement one', '',
    '## Problem', '', 'The widget fails.', '',
    '## Expected behavior', '', 'It works.', '',
    '## Scope', '', 'Widget only.', '',
    '## Acceptance criteria', '',
    '- [ ] AC-1: widget works',
    extraAc, '',
  ].join('\n');
}

function decision(): string {
  return [
    '---', 'schema: harness-note/1', `id: ${DEC}`, 'kind: decision',
    'lifecycle: accepted', 'created: 2026-09-17', '---', '',
    '# Decision one', '',
    '## Problem', '', 'Which way.', '',
    '## Proposal', '', 'This way.', '',
    '## Alternatives considered', '', 'That way.', '',
    '## Risks', '', 'Low.', '',
  ].join('\n');
}

function taskNote(id: string, title: string, relations: string, execution = ''): string {
  return [
    '---', 'schema: harness-note/1', `id: ${id}`, 'kind: task',
    'lifecycle: accepted', 'created: 2026-09-17',
    'work:',
    '  scope:',
    `    - repoId: ${REPO}`,
    "      paths: ['./']",
    '  acceptanceRefs:',
    `    - uri: ${REQ_URI}`,
    '      criterionId: AC-1',
    '  verification:',
    '    - id: v1',
    '      kind: manual',
    '      required: true',
    `      repoId: ${REPO}`,
    '      cwd: .',
    '      description: Eyeball it.',
    relations,
    execution,
    '---', '',
    `# ${title}`, '',
    '## Scope', '', 'Do the thing.', '',
    '## Acceptance criteria', '', '- [ ] AC-1: thing done', '',
    '## Verification', '', 'Eyeball it.', '',
  ].join('\n');
}

function depTask(): string {
  return taskNote(
    DEP,
    'Dep task',
    '',
    [
      'execution:',
      '  mode: xdo',
      '  state: done',
      '  baseline:',
      `    taskContractHash: ${'a'.repeat(64)}`,
      '    inputs: []',
      '  attempt: 1',
      '  receipts: [rc-dep]',
      '  closeout: commit-required',
    ].join('\n'),
  );
}

function mainTask(): string {
  return taskNote(
    MAIN,
    'Main task',
    [
      'relations:',
      '  - type: implements',
      `    target: ${REQ_URI}`,
      '    criteria: [AC-1]',
      '  - type: governed-by',
      `    target: note://${REPO}/${DEC}`,
      '  - type: depends-on',
      `    target: note://${REPO}/${DEP}`,
    ].join('\n'),
  );
}

function coveringReceipt(): Record<string, unknown> {
  return {
    schema: 'harness-receipt/1',
    id: 'rc1',
    taskUri: REQ_URI,
    mode: 'xdo',
    attempt: 1,
    taskContractHash: 'b'.repeat(64),
    inputs: [{ uri: REQ_URI, contentHash: 'c'.repeat(64) }],
    codeManifest: [],
    checks: [{ id: 'v1', kind: 'manual', required: true, status: 'passed', repoId: REPO, summary: 'eyeballed', performedBy: 'someone' }],
    coverage: [{ uri: REQ_URI, criterionId: 'AC-1', criterionHash: criterionHash(acLine('AC-1', 'widget works')), checkIds: ['v1'] }],
    review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'someone' },
    createdAt: '2026-09-17T00:00:00.000Z',
    actor: 'someone',
  };
}

function seed(root: string, opts: { evidence?: boolean; depReceipt?: boolean } = {}): void {
  const { evidence = true, depReceipt = true } = opts;
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), requirement());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dec--33333333.md'), decision());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), depTask());
  writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), mainTask());
  if (evidence || depReceipt) mkdirSync(join(root, '.agents', 'evidence'), { recursive: true });
  if (evidence) writeFileSync(join(root, '.agents', 'evidence', 'rc1.json'), JSON.stringify(coveringReceipt()));
  if (depReceipt) writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify({ ok: true }));
}

describe('collectTaskBaseline', () => {
  it('pins the contract plus related digests deterministically', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const first = await collectTaskBaseline(root, MAIN);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.baseline.taskUri).toBe(`note://${REPO}/${MAIN}`);
      expect(first.baseline.taskContractHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.baseline.inputs.map((i) => i.uri).sort()).toEqual(
        [`note://${REPO}/${DEC}`, `note://${REPO}/${DEP}`, REQ_URI].sort(),
      );
      const req = first.baseline.inputs.find((i) => i.uri === REQ_URI);
      expect(req?.criteria).toEqual(['AC-1']);
      const second = await collectTaskBaseline(root, MAIN);
      expect(second).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves full URIs as well as bare ids', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const byUri = await collectTaskBaseline(root, `note://${REPO}/${MAIN}`);
      expect(byUri.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses non-tasks, drafts, unknown refs, and unresolved targets', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const nonTask = await collectTaskBaseline(root, REQ);
      expect(nonTask.ok).toBe(false);
      if (!nonTask.ok) expect(nonTask.problems[0]?.code).toBe('SCHEMA_INVALID');
      const unknown = await collectTaskBaseline(root, '99999999-9999-4999-8999-999999999999');
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.problems[0]?.code).toBe('NOT_FOUND');
      writeFileSync(
        join(root, '.agents', 'notes', '2026-09-17-draft--66666666.md'),
        '---\nschema: harness-note/1\nid: 66666666-6666-4666-8666-666666666666\nkind: task\nlifecycle: draft\ncreated: 2026-09-17\n---\n\n# Draft\n\n## Scope\n\nS.\n',
      );
      const draft = await collectTaskBaseline(root, '66666666-6666-4666-8666-666666666666');
      expect(draft.ok).toBe(false);
      if (!draft.ok) expect(draft.problems[0]?.code).toBe('NOT_READY');
      const ghost = mainTask().replace(`note://${REPO}/${DEP}`, `note://${REPO}/77777777-7777-4777-8777-777777777777`);
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), ghost);
      const missing = await collectTaskBaseline(root, MAIN);
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.problems.some((p) => p.code === 'UNRESOLVED_REFERENCE')).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses uncovered acceptance and names the criteria', async () => {
    const root = makeRepo();
    try {
      seed(root, { evidence: false });
      const out = await collectTaskBaseline(root, MAIN);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.problems.some((p) => p.code === 'DEPENDENCY_UNSATISFIED' && p.message.includes('AC-1'))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses undone predecessors and missing receipt files', async () => {
    const root = makeRepo();
    try {
      seed(root, { depReceipt: false });
      const missing = await collectTaskBaseline(root, MAIN);
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.problems.some((p) => p.code === 'UNRESOLVED_REFERENCE' && p.message.includes('rc-dep'))).toBe(true);
      }
      const running = depTask().replace('state: done', 'state: running');
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), running);
      const undone = await collectTaskBaseline(root, MAIN);
      expect(undone.ok).toBe(false);
      if (!undone.ok) {
        expect(undone.problems.some((p) => p.code === 'DEPENDENCY_UNSATISFIED')).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses dependency cycles with the chain', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const cyclic = depTask().replace(
        '---\n\n# Dep task',
        `relations:\n  - type: depends-on\n    target: note://${REPO}/${MAIN}\n---\n\n# Dep task`,
      );
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), cyclic);
      const out = await collectTaskBaseline(root, MAIN);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.problems.some((p) => p.code === 'INVALID_RELATION' && p.message.includes('cycle'))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves the digest when requirement prose moves', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const before = await collectTaskBaseline(root, MAIN);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const moved = requirement().replace('Widget only.', 'Widget and sprocket.');
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), moved);
      const after = await collectTaskBaseline(root, MAIN);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const hashOf = (r: typeof before) => r.baseline.inputs.find((i) => i.uri === REQ_URI)?.contentHash;
      expect(hashOf(after)).not.toBe(hashOf(before));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proves coverage per criterion from evidence receipts', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const index = await buildNoteIndex(root);
      const entry = index.byId.get(REQ);
      expect(entry?.note).toBeDefined();
      if (!entry?.note) return;
      const full = await proveRequirementCoverage(root, REPO, REQ_URI, entry.note);
      expect(full.covered).toBe(true);
      const two = requirement(REQ, '- [ ] AC-2: sprocket spins');
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), two);
      const index2 = await buildNoteIndex(root);
      const note2 = index2.byId.get(REQ)?.note;
      expect(note2).toBeDefined();
      if (!note2) return;
      const partial = await proveRequirementCoverage(root, REPO, REQ_URI, note2);
      expect(partial.covered).toBe(false);
      expect(partial.uncovered).toEqual(['AC-2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
