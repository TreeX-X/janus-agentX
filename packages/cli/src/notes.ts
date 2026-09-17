// Note: janus notes reuses the notes-cli command functions — see .agents/notes/implemented/architecture/2026-09-17-cli-notes-harness-s8.md
/**
 * @file `janus notes` argv group (S8 slice 8b-1).
 * @description Same operations as `wfx-notes` over the same command
 *  functions (`cmdList/cmdShow/cmdCreate/cmdCheck/cmdApply`); only argv
 *  parsing and human rendering live here. Exit codes come from `exitFor`
 *  and the `--json` envelope is `{ok,data,errors}`, identical in both
 *  CLIs. No model, no network, no long-lived services.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  cmdApply,
  cmdCheck,
  cmdCreate,
  cmdList,
  cmdShow,
  exitFor,
  type CliResult,
  type CreateInput,
} from '@janus-agent/notes-cli';

export interface NotesRunOut {
  exit: number;
  stdout: string;
  stderr: string;
}

export function notesUsage(): string {
  return [
    'janus notes [--root <dir>] [--json] <command> [args]',
    '  list [--kind K] [--lifecycle L] [--tag T] [--q TEXT]',
    '  show <id|uri|path>',
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
      const m = /^##\s+(.+?)\s*$/.exec(ln);
      if (m) {
        flush();
        cur = m[1];
        continue;
      }
    }
    if (cur !== null) buf.push(ln);
  }
  flush();
  return out;
}

function human(result: CliResult): string {
  if (!result.ok) {
    return result.errors.map((e) => `${e.code}: ${e.message}${e.path ? ` (${e.path})` : ''}`).join('\n') + '\n';
  }
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return 'ok\n';
  if (Array.isArray(data['notes'])) {
    const notes = data['notes'] as Array<{ id: string; title: string; kind: string; lifecycle: string; relPath: string }>;
    if (notes.length === 0) return '(no notes)\n';
    return notes.map((n) => `${n.id.slice(0, 8)} [${n.kind}/${n.lifecycle}] ${n.title} (${n.relPath})`).join('\n') + '\n';
  }
  if (typeof data['text'] === 'string') {
    const text = data['text'] as string;
    return text.endsWith('\n') ? text : text + '\n';
  }
  if (typeof data['relPath'] === 'string') return `${data['relPath'] as string}\n`;
  if (typeof data['txId'] === 'string') {
    return `applied ${String((data as Record<string, unknown>)['applied'] ?? '?')} ops (tx ${data['txId'] as string})\n`;
  }
  if (typeof data['files'] === 'number') {
    const rows = (data['rows'] as Array<{ relPath: string; diagnostics: unknown[] }> ?? [])
      .filter((r) => r.diagnostics.length > 0)
      .map((r) => `FAIL ${r.relPath}`);
    return [`${String(data['files'])} files checked, ${rows.length} with diagnostics`, ...rows].join('\n') + '\n';
  }
  return 'ok\n';
}

function emit(result: CliResult, json: boolean): NotesRunOut {
  const exit = result.ok ? 0 : exitFor(result.errors);
  return { exit, stdout: json ? JSON.stringify({ ok: result.ok, data: result.data ?? null, errors: result.errors }, null, 2) + '\n' : human(result), stderr: '' };
}

function usageOut(json: boolean): NotesRunOut {
  return {
    exit: 2,
    stdout: json ? JSON.stringify({ ok: false, data: null, errors: [{ code: 'SCHEMA_INVALID', message: 'notes needs a subcommand' }] }) + '\n' : notesUsage() + '\n',
    stderr: '',
  };
}

export async function runNotes(rawArgv: string[], cwd: string): Promise<NotesRunOut> {
  const argv = [...rawArgv];
  const root = resolve(cwd, takeFlag(argv, '--root') ?? '.');
  const json = hasFlag(argv, '--json');
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return usageOut(json);
  try {
    switch (cmd) {
      case 'list': {
        const a = [...rest];
        return emit(await cmdList(root, {
          kind: takeFlag(a, '--kind'),
          lifecycle: takeFlag(a, '--lifecycle'),
          tag: takeFlag(a, '--tag'),
          q: takeFlag(a, '--q'),
        }), json);
      }
      case 'show': {
        if (!rest[0]) return usageOut(json);
        return emit(await cmdShow(root, rest[0]), json);
      }
      case 'create': {
        const a = [...rest];
        const kind = takeFlag(a, '--kind');
        const title = takeFlag(a, '--title');
        const bodyFile = takeFlag(a, '--body-file');
        if (!kind || !title || !bodyFile) return usageOut(json);
        const sections = parseSections(await readFile(resolve(cwd, bodyFile), 'utf8'));
        const tags = takeFlag(a, '--tags');
        return emit(await cmdCreate(root, {
          kind: kind as CreateInput['kind'],
          title,
          sections,
          lifecycle: takeFlag(a, '--lifecycle'),
          class: takeFlag(a, '--class') as CreateInput['class'],
          tags: tags ? tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        }), json);
      }
      case 'check':
        return emit(await cmdCheck(root), json);
      case 'apply': {
        const file = rest.find((x) => !x.startsWith('--'));
        if (!file) return usageOut(json);
        const a = [...rest];
        const only = takeFlag(a, '--only');
        const allowDelete = hasFlag(a, '--allow-delete') || a.includes('--allow-delete');
        return emit(await cmdApply(root, resolve(cwd, file), {
          selection: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          allowDelete,
        }), json);
      }
      default:
        return usageOut(json);
    }
  } catch (e) {
    const errors = [{ code: 'IO_ERROR' as const, message: String(e) }];
    return { exit: 5, stdout: json ? JSON.stringify({ ok: false, data: null, errors }, null, 2) + '\n' : `${String(e)}\n`, stderr: '' };
  }
}
