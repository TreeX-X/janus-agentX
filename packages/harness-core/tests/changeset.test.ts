/** Change-set and bundle rules (C5-C6). */
import { describe, expect, it } from 'vitest';
import { validateBundle, validateChangeSet } from '../src/index.js';

const R = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const uriA = `note://${R}/${A}`;
const H = 'a'.repeat(64);

const op = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  operationId: 'op-1',
  type: 'create',
  uri: uriA,
  expectedHash: null,
  afterMarkdown: '# T\n',
  dependsOn: [],
  reason: 'roundtable decision',
  evidenceRefs: [],
  ...over,
});

const cs = (ops: Record<string, unknown>[]): Record<string, unknown> => ({
  id: 'cs-1',
  revision: 1,
  source: { type: 'roundtable', id: 'rt-1', revision: 1 },
  operations: ops,
});

describe('changeset', () => {
  it('accepts a minimal create', () => {
    expect(validateChangeSet(cs([op()]))).toEqual([]);
  });
  it('pins exact hashes for replace/delete and forbids delete prose', () => {
    expect(validateChangeSet(cs([op({ operationId: 'op-2', type: 'replace', expectedHash: H })]))).toEqual([]);
    const badDelete = validateChangeSet(cs([op({ operationId: 'op-3', type: 'delete', expectedHash: H })]));
    expect(badDelete.some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    const noHash = validateChangeSet(cs([op({ operationId: 'op-4', type: 'replace', expectedHash: 'short' })]));
    expect(noHash.some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
  });
  it('rejects duplicate ids and dependsOn loops', () => {
    expect(validateChangeSet(cs([op(), op()])).some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    const looped = cs([
      op({ operationId: 'a', dependsOn: ['b'] }),
      op({ operationId: 'b', dependsOn: ['a'] }),
    ]);
    expect(validateChangeSet(looped).some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
  });
});

describe('bundle', () => {
  const bundle = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: 'harness-bundle/1',
    id: 'b-1',
    revision: 1,
    producer: { type: 'roundtable', id: 'rt-1', revision: 1 },
    artifacts: [{ artifactId: 'a-1', operationId: 'op-1', sourceRefs: ['fact-1'] }],
    changeSet: { id: 'cs-1' },
    coverage: {},
    unresolved: [],
    ...over,
  });
  it('accepts a well-formed bundle', () => {
    expect(validateBundle(bundle())).toEqual([]);
  });
  it('forbids forked prose on artifacts', () => {
    const bad = bundle({ artifacts: [{ artifactId: 'a-1', operationId: 'op-1', sourceRefs: [], afterMarkdown: '# X' }] });
    expect(validateBundle(bad).some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
  });
});
