#!/usr/bin/env node
// Note: offline notes entry lives here — see .agents/notes/implemented/architecture/2026-09-16-harness-node-cli-s3.md
/**
 * wfx-notes: offline-first notes CLI. Deterministic file operations only;
 * no network, no model calls, no long-lived services.
 */
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { cmdApply, cmdCheck, cmdCreate, cmdList, cmdResult, cmdShow, exitFor, type CliResult, type CreateInput } from './commands.js';

export interface RunOut {
  exit: number;
  stdout: string;
  stderr: string;
}

function usage(): string {
  return [
    'wfx-notes [--root <dir>] [--json] <command> [args]',
    '  list [--kind K] [--lifecycle L] [--tag T] [--q TEXT]',
    '  show <id|uri|path>',
    '  result <id|uri|path> [--closeout]',
    '  create --kind K --title T --body-file F [--lifecycle L] [--class C] [--tags a,b]',
    '  check',
    '  apply <changeset.json> [--only op1,op2] [--allow-delete]',
  ].join('\n');
}

function takeFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

function hasFlag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

export async function run(rawArgv: string[], cwd: string): Promise<RunOut> {
  const argv = [...rawArgv];
  const root = resolve(cwd, takeFlag(argv, '--root') ?? '.');
  const json = hasFlag(argv, '--json');
  const emit = (result: CliResult): RunOut => {
    const exit = result.ok ? 0 : exitFor(result.errors);
    const stdout = json
      ? JSON.stringify({ ok: result.ok, data: result.data ?? null, errors: result.errors }, null, 2) + '\n'
      : human(result);
    return { exit, stdout, stderr: '' };
  };
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'list': {
        const a = [...rest];
        return emit(
          await cmdList(root, {
            kind: takeFlag(a, '--kind'),
            lifecycle: takeFlag(a, '--lifecycle'),
            tag: takeFlag(a, '--tag'),
            q: takeFlag(a, '--q'),
          }),
        );
      }
      case 'show': {
        if (!rest[0]) return { exit: 2, stdout: json ? JSON.stringify({ ok: false, data: null, errors: [{ code: 'SCHEMA_INVALID', message: 'show needs a ref' }] }) + '\n' : usage() + '\n', stderr: '' };
        return emit(await cmdShow(root, rest[0]));
      }
      case 'result': {
        if (!rest[0] || rest[0].startsWith('--')) return emit({ ok: false, errors: [{ code: 'SCHEMA_INVALID', message: 'result needs a task ref' }] });
        return emit(await cmdResult(root, rest[0], rest.includes('--closeout')));
      }
      case 'create': {
        const a = [...rest];
        const kind = takeFlag(a, '--kind');
        const title = takeFlag(a, '--title');
        const bodyFile = takeFlag(a, '--body-file');
        if (!kind || !title || !bodyFile) {
          return { exit: 2, stdout: usage() + '\n', stderr: '' };
        }
        const sections = parseSections(await readFile(resolve(cwd, bodyFile), 'utf8'));
        const tags = takeFlag(a, '--tags');
        return emit(
          await cmdCreate(root, {
            kind: kind as CreateInput['kind'],
            title,
            sections,
            lifecycle: takeFlag(a, '--lifecycle'),
            class: takeFlag(a, '--class') as CreateInput['class'],
            tags: tags ? tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          }),
        );
      }
      case 'check':
        return emit(await cmdCheck(root));
      case 'apply': {
        const file = rest.find((x) => !x.startsWith('--'));
        if (!file) return { exit: 2, stdout: usage() + '\n', stderr: '' };
        const a = [...rest];
        const only = takeFlag(a, '--only');
        const allowDelete = hasFlag(a, '--allow-delete') || a.includes('--allow-delete');
        return emit(
          await cmdApply(root, resolve(cwd, file), {
            selection: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            allowDelete,
          }),
        );
      }
      default:
        return { exit: 2, stdout: usage() + '\n', stderr: '' };
    }
  } catch (e) {
    const errors = [{ code: 'IO_ERROR' as const, message: String(e) }];
    return { exit: 5, stdout: json ? JSON.stringify({ ok: false, data: null, errors }, null, 2) + '\n' : String(e) + '\n', stderr: '' };
  }
}

function parseSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cur: string | null = null;
  let buf: string[] = [];
  let fence = false;
  const flush = (): void => {
    if (cur !== null) out[cur] = buf.join('\n').replace(/^\n+|\n+$/g, '');
    cur = null;
    buf = [];
  };
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      if (cur !== null) buf.push(ln);
      continue;
    }
    if (!fence) {
      const h2 = /^##\s+(.+)$/.exec(ln);
      if (h2) {
        flush();
        cur = h2[1].trim();
        continue;
      }
      if (/^#\s+/.test(ln)) {
        flush();
        continue;
      }
    }
    if (cur !== null) buf.push(ln);
  }
  flush();
  return out;
}

function human(result: CliResult): string {
  if (!result.ok) return result.errors.map((e) => `${e.code}: ${e.message}`).join('\n') + '\n';
  return JSON.stringify(result.data, null, 2) + '\n';
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '');
if (isMain) {
  run(process.argv.slice(2), process.cwd()).then(
    (out) => {
      process.stdout.write(out.stdout);
      process.stderr.write(out.stderr);
      process.exit(out.exit);
    },
    (e) => {
      process.stderr.write(String(e) + '\n');
      process.exit(5);
    },
  );
}
