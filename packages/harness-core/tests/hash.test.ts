/** F02: contract-hash stability, locked against the S1 sample value. */
import { describe, expect, it } from 'vitest';
import { parseNote, taskContractHash, type ParsedNote } from '../src/index.js';

const LOCKED = '73e315502bb2e0678461ba859f4d16d73c101bdd55d2c167ecbee36eae1b8ae6';

function s1Task(): ParsedNote {
  const meta = {
    schema: 'harness-note/1',
    id: '55555555-5555-4555-8555-555555555555',
    kind: 'task',
    lifecycle: 'accepted',
    created: '2026-09-16',
    class: 'feature',
    tags: ['harness', 's1'],
    repositories: { primary: '8fa19f17-c717-43a8-93a7-810a5e0cbc91' },
    relations: [
      {
        type: 'implements',
        target: 'note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/33333333-3333-4333-8333-333333333333',
        criteria: ['AC-1'],
      },
      {
        type: 'governed-by',
        target: 'note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/44444444-4444-4444-8444-444444444444',
      },
    ],
    work: {
      scope: [{ repoId: '8fa19f17-c717-43a8-93a7-810a5e0cbc91', paths: ['standards/harness-note/1/'] }],
      acceptanceRefs: [
        {
          uri: 'note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/33333333-3333-4333-8333-333333333333',
          criterionId: 'AC-1',
        },
      ],
      verification: [
        {
          id: 'V-1',
          kind: 'command',
          required: true,
          repoId: '8fa19f17-c717-43a8-93a7-810a5e0cbc91',
          cwd: '.',
          program: 'node',
          args: ['scripts/verify-harness-standard.mjs'],
        },
      ],
    },
  } as unknown as ParsedNote['meta'];
  return {
    meta,
    unknownFields: {},
    keyOrder: [],
    title: 'Candidate standard S1 task',
    sections: [
      { name: 'Scope', text: 'Deliver the versioned standard, templates, and fixtures for harness-note/1.' },
      { name: 'Acceptance criteria', text: 'Inherited clauses live in metadata; this task owns no extra AC.' },
      {
        name: 'Verification',
        text: '- V-1: Run `node scripts/verify-harness-standard.mjs`; required checks pass.',
      },
    ],
    acs: [],
    body: [
      '# Candidate standard S1 task',
      '',
      '## Scope',
      '',
      'Deliver the versioned standard, templates, and fixtures for harness-note/1.',
      '',
      '## Acceptance criteria',
      '',
      'Inherited clauses live in metadata; this task owns no extra AC.',
      '',
      '## Verification',
      '',
      '- V-1: Run `node scripts/verify-harness-standard.mjs`; required checks pass.',
      '',
    ].join('\n'),
    eol: '\n',
    bom: false,
  };
}

describe('taskContractHash', () => {
  it(`matches the S1 locked sample ${LOCKED.slice(0, 12)}…`, () => {
    expect(taskContractHash(s1Task())).toBe(LOCKED);
  });
  it('ignores execution/tags/organizing-link writes', () => {
    const a = s1Task();
    const b = s1Task();
    b.meta = {
      ...b.meta,
      tags: ['other'],
      parent: 'note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/22222222-2222-4222-8222-222222222222',
      execution: {
        mode: 'xdo',
        state: 'running',
        baseline: { taskContractHash: LOCKED, inputs: [] },
        attempt: 1,
        receipts: [],
        closeout: 'commit-required',
      },
    };
    b.sections = [...b.sections, { name: 'Results', text: 'progress notes' }];
    expect(taskContractHash(b)).toBe(taskContractHash(a));
  });
  it('moves on scope/relation/work edits', () => {
    const base = taskContractHash(s1Task());
    const moved = s1Task();
    moved.meta = {
      ...moved.meta,
      work: { ...moved.meta.work!, scope: [{ repoId: '8fa19f17-c717-43a8-93a7-810a5e0cbc91', paths: ['other/'] }] },
    };
    expect(taskContractHash(moved)).not.toBe(base);
  });
  it('is LF/CRLF blind', () => {
    const raw = [
      '---',
      'schema: harness-note/1',
      'id: 55555555-5555-4555-8555-555555555555',
      'kind: task',
      'lifecycle: accepted',
      'created: 2026-09-16',
      'work:',
      '  scope:',
      '    - repoId: 8fa19f17-c717-43a8-93a7-810a5e0cbc91',
      '      paths: ["./"]',
      '  acceptanceRefs:',
      '    - uri: note://8fa19f17-c717-43a8-93a7-810a5e0cbc91/33333333-3333-4333-8333-333333333333',
      '      criterionId: AC-1',
      '  verification:',
      '    - id: V-1',
      '      kind: command',
      '      required: true',
      '      repoId: 8fa19f17-c717-43a8-93a7-810a5e0cbc91',
      '      cwd: .',
      '      program: node',
      '      args: ["x"]',
      '---',
      '',
      '# T',
      '',
      '## Scope',
      '',
      'S',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] AC-1: One.',
      '',
      '## Verification',
      '',
      'V.',
      '',
    ].join('\n');
    const lf = taskContractHash(parseNote(raw));
    const crlf = taskContractHash(parseNote(raw.replace(/\n/g, '\r\n')));
    expect(crlf).toBe(lf);
  });
});
