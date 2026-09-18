/**
 * Task baseline collection: contract pin, related-note digests, coverage
 * proof, predecessor receipts, and refusal taxonomy. Temp checkouts only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentDigest, criterionHash, parseNote, taskContractHash } from '@janus-agent/harness-core';
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
  const text = taskNote(
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
  ).replace(`uri: ${REQ_URI}`, `uri: note://${REPO}/${DEP}`);
  return text.replace('a'.repeat(64), taskContractHash(parseNote(text)));
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
  const note = parseNote(requirement());
  const sections = Object.fromEntries(note.sections.filter((s) => ['Problem', 'Expected behavior', 'Scope'].includes(s.name)).map((s) => [s.name, s.text]));
  const digest = contentDigest({ uri: REQ_URI, kind: 'requirement', lifecycle: 'accepted', sections, criteria: { 'AC-1': acLine('AC-1', 'widget works') } }).digest;
  return {
    schema: 'harness-receipt/1',
    id: 'rc1',
    mode: 'xdo',
    attempt: 1,
    inputs: [{ uri: REQ_URI, contentHash: digest, criteria: ['AC-1'] }],
    codeManifest: [],
    checks: [{ id: 'v1', kind: 'manual', required: true, status: 'passed', repoId: REPO, summary: 'eyeballed', performedBy: 'someone' }],
    coverage: [{ uri: REQ_URI, criterionId: 'AC-1', criterionHash: criterionHash(acLine('AC-1', 'widget works')), checkIds: ['v1'] }],
    review: { kind: 'manual', verdict: 'approved', reviewedManifestHash: 'e'.repeat(64), actor: 'someone' },
    createdAt: '2026-09-17T00:00:00.000Z',
    actor: 'someone',
  };
}

function dependencyReceipt(text = depTask()): Record<string, unknown> {
  const uri = `note://${REPO}/${DEP}`;
  return {
    ...coveringReceipt(), id: 'rc-dep', taskUri: uri, taskContractHash: taskContractHash(parseNote(text)), inputs: [],
    coverage: [{ uri, criterionId: 'AC-1', criterionHash: criterionHash(acLine('AC-1', 'thing done')), checkIds: ['v1'] }],
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
  if (depReceipt) writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify(dependencyReceipt()));
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

  it('allows implementing uncovered goals but still gates explicit requirement dependencies', async () => {
    const root = makeRepo();
    try {
      seed(root, { evidence: false });
      expect((await collectTaskBaseline(root, MAIN)).ok).toBe(true);
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), mainTask().replace('  - type: governed-by', `  - type: depends-on\n    target: ${REQ_URI}\n  - type: governed-by`));
      const out = await collectTaskBaseline(root, MAIN);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.problems.some((p) => p.code === 'DEPENDENCY_UNSATISFIED' && p.message.includes('AC-1'))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resolves a foreign repository URI by a colliding local note id', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const foreign = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const wrongTask = await collectTaskBaseline(root, `note://${foreign}/${MAIN}`);
      expect(wrongTask.ok).toBe(false);
      if (!wrongTask.ok) expect(wrongTask.problems[0].code).toBe('UNRESOLVED_REFERENCE');
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), mainTask().replace(`note://${REPO}/${DEC}`, `note://${foreign}/${DEC}`));
      const wrongTarget = await collectTaskBaseline(root, MAIN);
      expect(wrongTarget.ok).toBe(false);
      if (!wrongTarget.ok) expect(wrongTarget.problems.some((d) => d.code === 'UNRESOLVED_REFERENCE')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('pins decisions governing the target requirement', async () => {
    const root = makeRepo();
    try {
      seed(root);
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-main--55555555.md'), mainTask().replace(`  - type: governed-by\n    target: note://${REPO}/${DEC}\n`, ''));
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), requirement().replace('created: 2026-09-17', `created: 2026-09-17\nrelations:\n  - type: governed-by\n    target: note://${REPO}/${DEC}`));
      const result = await collectTaskBaseline(root, MAIN);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.baseline.inputs.map((i) => i.uri)).toContain(`note://${REPO}/${DEC}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires resolved acceptance refs, matching implements edges, and adopted inputs', async () => {
    const root = makeRepo();
    try {
      seed(root);
      const mainPath = join(root, '.agents', 'notes', '2026-09-17-main--55555555.md');
      for (const changed of [mainTask().replace('criterionId: AC-1', 'criterionId: AC-99'), mainTask().replace('criteria: [AC-1]', 'criteria: [AC-2]')]) {
        writeFileSync(mainPath, changed);
        const result = await collectTaskBaseline(root, MAIN);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems.some((d) => d.code === 'INVALID_RELATION')).toBe(true);
      }
      writeFileSync(mainPath, mainTask());
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dec--33333333.md'), decision().replace('lifecycle: accepted', 'lifecycle: proposed'));
      const notAdopted = await collectTaskBaseline(root, MAIN);
      expect(notAdopted.ok).toBe(false);
      if (!notAdopted.ok) expect(notAdopted.problems.some((d) => d.code === 'NOT_READY')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
      let cyclic = depTask().replace(
        '---\n\n# Dep task',
        `relations:\n  - type: depends-on\n    target: note://${REPO}/${MAIN}\n---\n\n# Dep task`,
      );
      cyclic = cyclic.replace(taskContractHash(parseNote(depTask())), taskContractHash(parseNote(cyclic)));
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), cyclic);
      writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify(dependencyReceipt(cyclic)));
      const out = await collectTaskBaseline(root, MAIN);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.problems.some((p) => p.code === 'DEPENDENCY_UNSATISFIED' || p.code === 'INVALID_RELATION')).toBe(true);
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

  it('refuses fake or failed predecessor receipts and a changed predecessor contract', async () => {
    const root = makeRepo();
    try {
      seed(root);
      for (const value of [{ ok: true }, { ...dependencyReceipt(), review: { ...(dependencyReceipt().review as object), verdict: 'needs-fix' } }]) {
        writeFileSync(join(root, '.agents', 'evidence', 'rc-dep.json'), JSON.stringify(value));
        const refused = await collectTaskBaseline(root, MAIN);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.problems.some((d) => d.code === 'DEPENDENCY_UNSATISFIED')).toBe(true);
      }
      seed(root);
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-dep--44444444.md'), depTask().replace('Do the thing.', 'Do a different thing.'));
      const stale = await collectTaskBaseline(root, MAIN);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.problems.some((d) => d.code === 'STALE_BASELINE')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not count failed review, recreated deletions, foreign files, or unpinned coverage', async () => {
    const root = makeRepo();
    try {
      seed(root);
      writeFileSync(join(root, 'returned.txt'), 'still here');
      const note = parseNote(requirement());
      const good = coveringReceipt();
      for (const value of [
        { ...good, review: { ...(good.review as object), verdict: 'needs-fix' } },
        { ...good, codeManifest: [{ repoId: REPO, path: 'returned.txt', deleted: true }] },
        { ...good, codeManifest: [{ repoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: 'other.txt', deleted: true }] },
        { ...good, inputs: [] },
        { ...good, checks: [null] },
      ]) {
        writeFileSync(join(root, '.agents', 'evidence', 'rc1.json'), JSON.stringify(value));
        expect((await proveRequirementCoverage(root, REPO, REQ_URI, note)).covered).toBe(false);
      }
      writeFileSync(join(root, '.agents', 'evidence', 'rc1.json'), JSON.stringify(good));
      const moved = requirement().replace('Widget only.', 'A wider scope.');
      writeFileSync(join(root, '.agents', 'notes', '2026-09-17-req--11111111.md'), moved);
      expect((await proveRequirementCoverage(root, REPO, REQ_URI, parseNote(moved))).covered).toBe(false);
      expect((await proveRequirementCoverage(root, REPO, REQ_URI, { ...note, acs: [] })).covered).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
