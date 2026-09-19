import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { App } from '../src/tui/App.js';
import { CliSession, isSessionValidationError } from '../src/session.js';

const signals = vi.hoisted(() => [] as AbortSignal[]);
vi.mock('../src/tui/harness-host.js', () => ({
  createInkHarnessHost: (deps: { signal(): AbortSignal }) => ({
    isActive: () => true,
    exitMode: () => [],
    executeTurn: () => { throw new Error('unexpected turn'); },
    run: async () => {
      const signal = deps.signal();
      signals.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { stdout: ['task paused'], stderr: [] };
    },
  }),
}));

async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error('Ink command did not settle');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('gives each harness command a fresh abort signal and restores queued input after cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ink-command-'));
  const session = await CliSession.create({ workspace: root, model: 'm', apiKey: 'fixture', env: {} });
  if (isSessionValidationError(session)) throw new Error(session.message);
  const app = render(<App initialSession={session} host={{ createSession: async () => ({ error: 'test' }) }} onExit={vi.fn()} />);
  const enter = async (text: string) => {
    app.stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.stdin.write('\r');
  };
  try {
    await enter('/harness execute');
    await until(() => signals.length === 1);
    expect(signals[0].aborted).toBe(false);
    await enter('follow-up');
    app.stdin.write('\x03');
    await until(() => Boolean(app.lastFrame()?.includes('Pending messages restored')));
    expect(signals[0].aborted).toBe(true);
    expect(app.lastFrame()).toContain('follow-up');
    app.stdin.write('\x03'); // Clear restored input before another command.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await enter('/harness verify');
    await until(() => signals.length === 2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1].aborted).toBe(false);
    app.stdin.write('\x03');
    await until(() => signals[1].aborted);
  } finally {
    app.unmount();
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
