/** Graph rules: loops, symmetric-edge ownership, unresolved marking, gates. */
import { describe, expect, it } from 'vitest';
import {
  checkAcyclic,
  predecessorsSatisfied,
  relatedToOwner,
  unresolvedTargets,
  type GraphNode,
} from '../src/index.js';
import type { ParsedNote } from '../src/index.js';

const R = '8fa19f17-c717-43a8-93a7-810a5e0cbc91';
const uri = (id: string): string => `note://${R}/${id}`;
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function node(id: string, over: Partial<ParsedNote['meta']> = {}): GraphNode {
  return {
    uri: uri(id),
    note: {
      meta: {
        schema: 'harness-note/1',
        id,
        kind: 'requirement',
        lifecycle: 'accepted',
        created: '2026-09-16',
        ...over,
      },
      unknownFields: {},
      keyOrder: [],
      title: 'T',
      sections: [],
      acs: [],
      body: '',
      eol: '\n',
      bom: false,
    },
  };
}

describe('relations', () => {
  it('flags organizing-link loops', () => {
    const nodes = [node(A, { parent: uri(B) }), node(B, { parent: uri(A) })];
    const diags = checkAcyclic(nodes);
    expect(diags.some((d) => d.code === 'INVALID_RELATION')).toBe(true);
  });
  it('flags depends-on loops', () => {
    const nodes = [
      node(A, { kind: 'task', relations: [{ type: 'depends-on', target: uri(B) }] }),
      node(B, { kind: 'task', relations: [{ type: 'depends-on', target: uri(A) }] }),
    ];
    expect(checkAcyclic(nodes).some((d) => d.code === 'INVALID_RELATION')).toBe(true);
  });
  it('passes loop-free graphs', () => {
    const nodes = [node(A, { parent: uri(B) }), node(B)];
    expect(checkAcyclic(nodes)).toEqual([]);
  });
  it('stores symmetric edges at the smaller URI', () => {
    expect(relatedToOwner(uri(B), uri(A))).toBe(uri(A));
    expect(relatedToOwner(uri(A), uri(B))).toBe(uri(A));
  });
  it('marks absent targets unresolved instead of forging them', () => {
    const nodes = [node(A, { relations: [{ type: 'related-to', target: uri(B) }] })];
    expect(unresolvedTargets(nodes)).toEqual([{ from: uri(A), target: uri(B) }]);
  });
  it('gates starts on predecessor verdicts', () => {
    expect(predecessorsSatisfied([{ kind: 'task', done: true, acCovered: false }]).ok).toBe(true);
    expect(
      predecessorsSatisfied([
        { kind: 'task', done: false, acCovered: false },
        { kind: 'requirement', done: false, acCovered: true },
      ]).blocking,
    ).toBe(1);
  });
});
