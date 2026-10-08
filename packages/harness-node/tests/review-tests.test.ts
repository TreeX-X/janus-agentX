import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewTestSession } from '../src/review-tests.js';
import { sha256HexBytes } from '../src/repository.js';
import { parseReviewTestPlan, reviewTestVerdict } from '@janus-agent/harness-core';

const repoId = '11111111-1111-4111-8111-111111111111';
const criteria = [{ uri: `note://${repoId}/22222222-2222-4222-8222-222222222222`, criterionId: 'AC-1' }];
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(value = 42) {
  const root = await mkdtemp(join(tmpdir(), 'eval-tests-')); roots.push(root);
  await mkdir(join(root, 'src')); await mkdir(join(root, '.agents'));
  const body = `export function answer() { return ${value}; }`;
  await writeFile(join(root, 'src/value.mjs'), body); await writeFile(join(root, '.agents/task.md'), 'private task history');
  const command = vi.fn(async () => ({ ok: true, exitCode: 0, summary: 'existing tests passed' }));
  const input = { root, repoId, actor: 'evaluator', criteria, command,
    manifest: [{ repoId, path: 'src/value.mjs', sha256: sha256HexBytes(Buffer.from(body)) }],
    verification: [{ id: 'V-1', kind: 'command' as const, required: true, repoId, cwd: '.', program: 'node', args: ['--test'] }],
  };
  return { input, session: createReviewTestSession(input) };
}
const script = "import assert from 'node:assert/strict'; import { answer } from './src/value.mjs'; assert.equal(answer(), 42);";
const plan = (source = script) => ({ tests: [{ name: 'answer returns 42', criteria, source }] });
describe('evaluator test execution', () => {
  it.each([42, 41])('runs a real generated assertion against pinned source: %s', async value => {
    const { session } = await fixture(value);
    const checks = await session.run(plan());
    expect(checks[0], checks[0].summary).toMatchObject({ status: value === 42 ? 'passed' : 'failed', performedBy: 'evaluator', required: true });
    session.assertExecuted();
    expect(reviewTestVerdict('approved', checks)).toBe(value === 42 ? 'approved' : 'needs-fix');
    await expect(session.run(plan())).rejects.toThrow('already executed');
  });
  it('reruns only an exact declared check under evaluator identity', async () => {
    const { input, session } = await fixture();
    await session.run({ tests: [{ name: 'run declared suite', criteria, checkId: 'V-1' }] });
    expect(input.command).toHaveBeenCalledWith(input.verification[0], undefined);
    expect(session.checks[0].command).toEqual({ program: 'node', args: ['--test'], cwd: '.' });
    const other = createReviewTestSession(input);
    await expect(other.run({ tests: [{ name: 'invented', criteria, checkId: 'arbitrary' }] })).rejects.toThrow('declared');
  });
  it.each([
    "import { writeFileSync } from 'node:fs'; writeFileSync('src/value.mjs', 'bad');",
    "import { readFileSync } from 'node:fs'; readFileSync('../.agents/task.md');",
    "import { execFileSync } from 'node:child_process'; execFileSync(process.execPath, ['-e', 'process.exit(0)']);",
  ])('blocks source writes, history reads and child processes', async source => {
    const { input, session } = await fixture();
    const checks = await session.run(plan(source));
    expect(checks[0].status).toBe('not-run');
    expect(reviewTestVerdict('approved', checks)).toBe('blocked');
    expect(await readFile(join(input.root, 'src/value.mjs'), 'utf8')).toContain('return 42');
    expect(await readFile(join(input.root, '.agents/task.md'), 'utf8')).toBe('private task history');
  });
  it('allows disposable test fixtures without granting repository writes', async () => {
    const { session } = await fixture();
    const checks = await session.run(plan("import { writeFileSync, readFileSync } from 'node:fs'; import { join } from 'node:path'; import assert from 'node:assert/strict'; const p = join(process.env.WFX_TEST_TMP, 'fixture'); writeFileSync(p, 'x'); assert.equal(readFileSync(p, 'utf8'), 'x');"));
    expect(checks[0].status, checks[0].summary).toBe('passed');
  });
  it('cannot use a fixture junction to write back into the original checkout', async () => {
    const { input, session } = await fixture();
    const checks = await session.run(plan(`import { symlinkSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; const p = join(process.env.WFX_TEST_TMP, 'escape'); symlinkSync(${JSON.stringify(input.root)}, p, 'junction'); writeFileSync(join(p, 'src/value.mjs'), 'bad');`));
    expect(checks[0].status).not.toBe('passed');
    expect(await readFile(join(input.root, 'src/value.mjs'), 'utf8')).toContain('return 42');
  });
  it('refuses stale snapshots, canceled tests, unknown AC and missing execution', async () => {
    const { input, session } = await fixture();
    expect(() => session.assertExecuted()).toThrow('must execute');
    expect(() => parseReviewTestPlan({ tests: [{ name: 'wrong', criteria: [{ ...criteria[0], criterionId: 'AC-99' }], source: script }] }, criteria)).toThrow('SCHEMA_INVALID');
    await writeFile(join(input.root, 'src/value.mjs'), 'changed');
    await expect(session.run(plan())).rejects.toThrow('STALE_BASELINE');
    const abort = new AbortController(); abort.abort();
    await expect(createReviewTestSession(input).run(plan(), abort.signal)).rejects.toThrow();
  });
  it('records missing execution capability as not-run without passing it', async () => {
    const { session } = await fixture();
    const checks = await session.run({ tests: [], blocker: 'Requires a browser not available to this runner' });
    expect(checks[0].status).toBe('not-run');
    expect(reviewTestVerdict('approved', checks)).toBe('blocked');
  });
});
