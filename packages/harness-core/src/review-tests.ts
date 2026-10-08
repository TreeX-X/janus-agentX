// Note: evaluator-owned tests reuse fixed receipts — see .agents/notes/harness/workflowx-v2-adoption.md
import type { ReceiptCoverage, ReceiptCheck } from './receipt.js';

export interface ReviewTest {
  name: string;
  criteria: Array<{ uri: string; criterionId: string }>;
  checkId?: string;
  source?: string;
}
export interface ReviewTestPlan { tests: ReviewTest[]; blocker?: string }
export type RunReviewTests = (plan: unknown, signal?: AbortSignal) => Promise<ReceiptCheck[]>;

export function reviewTestVerdict(verdict: 'approved' | 'needs-fix' | 'blocked', checks: ReceiptCheck[]): typeof verdict {
  if (checks.some(check => check.required && check.status === 'not-run')) return 'blocked';
  if (verdict === 'approved' && checks.some(check => check.required && check.status === 'failed')) return 'needs-fix';
  return verdict;
}

/** Validate model requests against fixed AC before any execution. */
export function parseReviewTestPlan(raw: unknown, criteria: Pick<ReceiptCoverage, 'uri' | 'criterionId'>[]): ReviewTestPlan {
  const fail = (): never => { throw new Error('SCHEMA_INVALID: evaluator test plan needs named tests, fixed AC refs and exactly one checkId or source'); };
  if (!raw || typeof raw !== 'object') return fail();
  const plan = raw as ReviewTestPlan;
  if (!Array.isArray(plan.tests) || plan.tests.length > 12) return fail();
  if (!plan.tests.length && (typeof plan.blocker !== 'string' || !plan.blocker.trim())) return fail();
  const refs = new Set(criteria.map(ref => `${ref.uri}#${ref.criterionId}`));
  for (const test of plan.tests) {
    if (!test || typeof test.name !== 'string' || !test.name.trim() || test.name.length > 300 || !Array.isArray(test.criteria) || !test.criteria.length) return fail();
    if (test.criteria.some(ref => !ref || !refs.has(`${ref.uri}#${ref.criterionId}`))) return fail();
    const existing = typeof test.checkId === 'string' && !!test.checkId.trim();
    const script = typeof test.source === 'string' && !!test.source.trim() && test.source.length <= 32000;
    if (existing === script || (existing && test.source !== undefined) || (script && test.checkId !== undefined)) return fail();
  }
  return structuredClone(plan);
}

export const REVIEW_TEST_PLAN_INSTRUCTIONS = [
  'Independent evaluator: derive the smallest useful executable tests from the fixed acceptance criteria. Inspect source as needed before selecting tests.',
  'Return exactly one JSON test plan, not a verdict: {"tests":[{"name":"behavior and expected result","criteria":[{"uri":"note://.../...","criterionId":"AC-1"}],"checkId":"declared verification id"}]} .',
  'A checkId requests a fresh run of that exact Main-authored command. Alternatively replace checkId with source: a JavaScript ES module using node:assert/strict and Node builtins to test the pinned manifest files. A test must fail on a wrong result.',
  'Generated Node tests run from a copy of the manifest files with read-only source, no Task/history, no child processes or workers. Temporary fixtures may be written only under process.env.WFX_TEST_TMP. Imports outside the copied manifest are unavailable; use a declared command for installed test frameworks.',
  'Do not repeat checks or create trivial tests when a focused existing check is sufficient. At most 12 tests. If no available execution path can evaluate the AC, return {"tests":[],"blocker":"concrete missing capability"}. The host will execute the plan before your final verdict.',
].join('\n');
