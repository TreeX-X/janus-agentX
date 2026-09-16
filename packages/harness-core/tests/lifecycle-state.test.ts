/** Lifecycle table and task-state machine (C2-C3). */
import { describe, expect, it } from 'vitest';
import { checkLifecycle } from '../src/index.js';
import { checkOp } from '../src/index.js';

const base = {
  lifecycle: 'accepted',
  workReady: true,
  baselineValid: true,
  dependenciesReady: true,
  authorized: true,
  leaseHeld: true,
  receiptReady: false,
  repairBudgetLeft: true,
};

describe('lifecycle', () => {
  it('draft -> proposed -> accepted flows', () => {
    expect(checkLifecycle('draft', 'proposed', { kind: 'idea', authorized: true })).toEqual([]);
    expect(checkLifecycle('proposed', 'accepted', { kind: 'idea', authorized: true })).toEqual([]);
  });
  it('forbids jumping back from implemented', () => {
    expect(checkLifecycle('implemented', 'proposed', { kind: 'decision', authorized: true }).length).toBeGreaterThan(0);
  });
  it('reserves implemented for decisions', () => {
    expect(
      checkLifecycle('accepted', 'implemented', { kind: 'task', authorized: true }).some(
        (d) => d.code === 'SCHEMA_INVALID',
      ),
    ).toBe(true);
  });
  it('archives running tasks only when settled', () => {
    expect(
      checkLifecycle('accepted', 'archived', { kind: 'task', authorized: true, executionState: 'running' }).some(
        (d) => d.code === 'BUSY',
      ),
    ).toBe(true);
    expect(
      checkLifecycle('accepted', 'archived', { kind: 'task', authorized: true, executionState: 'done' }),
    ).toEqual([]);
  });
  it('needs authorization for adopt/revoke', () => {
    expect(
      checkLifecycle('accepted', 'proposed', { kind: 'requirement', authorized: false }).some(
        (d) => d.code === 'APPROVAL_REQUIRED',
      ),
    ).toBe(true);
  });
});

describe('task-state', () => {
  it('prepare needs an accepted, ready task', () => {
    expect(checkOp(undefined, 'prepare', base)).toEqual([]);
    expect(checkOp(undefined, 'prepare', { ...base, lifecycle: 'draft' }).some((d) => d.code === 'NOT_READY')).toBe(
      true,
    );
  });
  it('start pins baseline, deps, auth, and lease', () => {
    expect(checkOp('queued', 'start', base)).toEqual([]);
    expect(checkOp('queued', 'start', { ...base, leaseHeld: false }).some((d) => d.code === 'BUSY')).toBe(true);
  });
  it('finish needs a valid receipt', () => {
    expect(checkOp('verifying', 'finish', base).some((d) => d.code === 'NOT_READY')).toBe(true);
    expect(checkOp('verifying', 'finish', { ...base, receiptReady: true })).toEqual([]);
  });
  it('repair spends budget from verifying/blocked', () => {
    expect(checkOp('verifying', 'repair', base)).toEqual([]);
    expect(checkOp('verifying', 'repair', { ...base, repairBudgetLeft: false }).some((d) => d.code === 'BUSY')).toBe(
      true,
    );
    expect(checkOp('running', 'repair', base).length).toBeGreaterThan(0);
  });
  it('terminal states stay put', () => {
    expect(checkOp('done', 'cancel', base).length).toBeGreaterThan(0);
    expect(checkOp('running', 'cancel', base)).toEqual([]);
  });
});
