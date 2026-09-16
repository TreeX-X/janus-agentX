/**
 * Note parsing and single-file validation (contract C1-C2).
 * Frontmatter via `yaml` Document/CST (duplicate keys, custom tags and
 * anchors/aliases are rejected, never silently kept). Body structure via
 * mdast+GFM (fenced code never counts as headings or checklist items).
 * No filesystem access. Raw bytes stay with the caller (S3 owns files).
 */
import { parseDocument, visit, isMap, isScalar, isAlias } from 'yaml';
import type { Document, ParsedNode } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Root, RootContent, ListItem, Paragraph, PhrasingContent } from 'mdast';
import {
  AC_ID_RE,
  DATE_RE,
  HEX64_RE,
  KNOWN_TOP_KEYS,
  NOTE_URI_RE,
  UUID_RE,
  isLifecycle,
  isNoteKind,
  type AcceptanceItem,
  type BodySection,
  type Diagnostic,
  type ErrorCode,
  type HarnessNoteMeta,
  type ParsedNote,
} from './schema.js';

export interface SplitSource {
  fmText: string;
  body: string;
  eol: '\n' | '\r\n';
  bom: boolean;
}

function diag(code: ErrorCode, message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

/** Split `---` frontmatter from body. BOM and EOL style are recorded, not altered. */
export function splitFrontmatter(raw: string): SplitSource {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') throw Object.assign(new Error('missing opening ---'), { code: 'SCHEMA_INVALID' });
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) throw Object.assign(new Error('missing closing ---'), { code: 'SCHEMA_INVALID' });
  return { fmText: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n'), eol, bom };
}

function walkDuplicates(doc: Document<ParsedNode>): string | null {
  let dup: string | null = null;
  visit(doc, {
    Map(_key, node) {
      if (dup) return;
      const seen = new Set<string>();
      if (isMap(node)) {
        for (const pair of node.items) {
          const k = isScalar(pair.key) ? String(pair.key.value) : JSON.stringify(pair.key);
          if (seen.has(k)) {
            dup = k;
            return;
          }
          seen.add(k);
        }
      }
    },
  });
  return dup;
}
function walkYamlSafety(doc: Document<ParsedNode>): string | null {
  let bad: string | null = null;
  visit(doc, {
    Node(_key, node) {
      if (bad) return;
      if (isAlias(node)) {
        bad = 'alias/anchor forbidden';
        return;
      }
      const anchor = (node as { anchor?: unknown }).anchor;
      if (anchor !== undefined && anchor !== null) {
        bad = 'alias/anchor forbidden';
        return;
      }
      const tag = (node as { tag?: unknown }).tag;
      if (typeof tag === 'string' && tag.startsWith('!')) {
        bad = `custom YAML tag forbidden (${tag})`;
      }
    },
  });
  return bad;
}

/** `created` must read as a YYYY-MM-DD string (C1). YAML timestamps coerce to Date; accept and re-canonicalize. */
function readCreated(raw: unknown, fmText: string): { value: string } | { error: string } {
  if (typeof raw === 'string') {
    return DATE_RE.test(raw) ? { value: raw } : { error: 'created must be YYYY-MM-DD string' };
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const m = /^created:\s*(\d{4}-\d{2}-\d{2})\s*(?:#.*)?$/m.exec(fmText);
    if (m) return { value: m[1] };
    const y = raw.getFullYear();
    const mo = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return { value: `${y}-${mo}-${d}` };
  }
  return { error: 'created must be YYYY-MM-DD string' };
}

function plainText(nodes: PhrasingContent[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'inlineCode') out += (n as { value: string }).value;
    else if ('children' in n) out += plainText((n as { children: PhrasingContent[] }).children);
  }
  return out;
}

export interface BodyModel {
  titles: string[];
  h2: string[];
  acs: AcceptanceItem[];
}

/** Headings and GFM checklists from the AST. Code blocks never contribute. */
export function modelBody(bodyLf: string): BodyModel {
  const tree: Root = fromMarkdown(bodyLf, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const titles: string[] = [];
  const h2: string[] = [];
  const acs: AcceptanceItem[] = [];
  const visitChildren = (nodes: RootContent[]): void => {
    for (const n of nodes) {
      if (n.type === 'heading' && n.depth === 1) titles.push(plainText(n.children).trim());
      else if (n.type === 'heading' && n.depth === 2) h2.push(plainText(n.children).trim());
      else if (n.type === 'list') {
        for (const item of n.children) collectCheckItem(item as ListItem, acs);
        // Nested lists are visited through their items below.
        for (const item of n.children) {
          const li = item as ListItem;
          for (const c of li.children) {
            if (c.type === 'list') visitChildren([c]);
          }
        }
      }
    }
  };
  visitChildren(tree.children);
  return { titles, h2, acs };
}

function collectCheckItem(item: ListItem, acs: AcceptanceItem[]): void {
  if (item.checked !== true && item.checked !== false) return;
  const first = item.children[0];
  if (!first || first.type !== 'paragraph') return;
  const text = plainText((first as Paragraph).children);
  const m = /^\s*(AC-\d+)\s*:(.*)$/s.exec(text);
  if (!m) return;
  acs.push({ id: m[1], text: m[2].trim(), checked: item.checked });
}

/**
 * Line-based H2 slices: text from an H2 line end to the next H2/H1
 * (nested headings retained). This slicing is the hash-stable contract (C3);
 * the AST above is the validation view. Both agree on plain headings.
 */
export function sliceSections(bodyLf: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = bodyLf.split('\n');
  let cur: string | null = null;
  let buf: string[] = [];
  let fence = false;
  const flush = (): void => {
    if (cur !== null && names.includes(cur) && !(cur in out)) {
      out[cur] = buf.join('\n').replace(/^\n+|\n+$/g, '');
    }
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
        buf = [];
        continue;
      }
      if (/^#\s+/.test(ln)) {
        flush();
        cur = null;
        continue;
      }
    }
    if (cur !== null) buf.push(ln);
  }
  flush();
  return out;
}

/** All H2 slices in document order (validation + serialize helpers). */
export function sliceAllSections(bodyLf: string): BodySection[] {
  const sections: BodySection[] = [];
  const lines = bodyLf.split('\n');
  let cur: string | null = null;
  let buf: string[] = [];
  let fence = false;
  const flush = (): void => {
    if (cur !== null) sections.push({ name: cur, text: buf.join('\n').replace(/^\n+|\n+$/g, '') });
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
        buf = [];
        continue;
      }
      if (/^#\s+/.test(ln)) {
        flush();
        cur = null;
        continue;
      }
    }
    if (cur !== null) buf.push(ln);
  }
  flush();
  return sections;
}

export function badPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'empty path';
  if (p.includes('\\')) return 'backslash forbidden';
  if (/^[A-Za-z]:/.test(p) || p.startsWith('\\\\') || p.startsWith('//')) return 'drive/UNC forbidden';
  if (p.startsWith('/')) return 'absolute forbidden';
  if (p.split('/').includes('..')) return 'parent traversal forbidden';
  if (p.includes('*') || p.includes('?') || p.includes('[')) return 'glob forbidden';
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * All-digit 64-hex digests (e.g. placeholder zero hashes) parse as YAML
 * numbers. Digests are strings by contract, so restore them from source.
 */
function restoreHexStrings(data: Record<string, unknown>, fmText: string): void {
  const exec = data['execution'];
  if (!isRecord(exec)) return;
  const base = exec['baseline'];
  if (!isRecord(base)) return;
  const contractToks = [...fmText.matchAll(/taskContractHash:\s*([0-9A-Za-z]+)/g)].map((m) => m[1]);
  const contentToks = [...fmText.matchAll(/contentHash:\s*([0-9A-Za-z]+)/g)].map((m) => m[1]);
  if (typeof base['taskContractHash'] !== 'string' && contractToks[0] !== undefined) {
    base['taskContractHash'] = contractToks[0];
  }
  const inputs = base['inputs'];
  if (Array.isArray(inputs)) {
    inputs.forEach((inp, idx) => {
      if (isRecord(inp) && typeof inp['contentHash'] !== 'string' && contentToks[idx] !== undefined) {
        inp['contentHash'] = contentToks[idx];
      }
    });
  }
}

const KNOWN_SET = new Set<string>(KNOWN_TOP_KEYS as readonly string[]);

/** Parse only. Throws SCHEMA_INVALID/UNSUPPORTED_SCHEMA on malformed sources. */
export function parseNote(raw: string): ParsedNote {
  const { fmText, body, eol, bom } = splitFrontmatter(raw);
  const doc = parseDocument(fmText);
  if (doc.errors.length > 0) {
    throw Object.assign(new Error(`YAML: ${doc.errors[0].message}`), { code: 'SCHEMA_INVALID' });
  }
  const dup = walkDuplicates(doc);
  if (dup) throw Object.assign(new Error(`duplicate key '${dup}'`), { code: 'SCHEMA_INVALID' });
  const unsafe = walkYamlSafety(doc);
  if (unsafe) throw Object.assign(new Error(unsafe), { code: 'SCHEMA_INVALID' });
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (!isRecord(data)) throw Object.assign(new Error('frontmatter must be a mapping'), { code: 'SCHEMA_INVALID' });
  restoreHexStrings(data, fmText);
  const keyOrder: string[] = [];
  const contents = doc.contents;
  if (isMap(contents)) {
    for (const pair of contents.items) {
      if (isScalar(pair.key)) keyOrder.push(String(pair.key.value));
    }
  } else {
    throw Object.assign(new Error('frontmatter must be a mapping'), { code: 'SCHEMA_INVALID' });
  }
  if (data['schema'] !== 'harness-note/1') {
    throw Object.assign(new Error(`unsupported schema ${String(data['schema'])}`), { code: 'UNSUPPORTED_SCHEMA' });
  }
  const unknownFields: Record<string, unknown> = {};
  for (const k of Object.keys(data)) if (!KNOWN_SET.has(k)) unknownFields[k] = data[k];
  const created = readCreated(data['created'], fmText);
  const meta = { ...(data as unknown as HarnessNoteMeta) };
  if (!('error' in created)) meta.created = created.value;
  const bodyLf = body.replace(/\r\n/g, '\n');
  const model = modelBody(bodyLf);
  if (model.titles.length !== 1) {
    throw Object.assign(new Error(`exactly one H1 required, found ${model.titles.length}`), {
      code: 'SCHEMA_INVALID',
    });
  }
  return {
    meta,
    unknownFields,
    keyOrder,
    title: model.titles[0],
    sections: sliceAllSections(bodyLf),
    acs: model.acs,
    body,
    eol,
    bom,
  };
}

function draftNeed(kind: string): string[] {
  return (
    { idea: ['Background'], initiative: ['Goal'], requirement: ['Problem'], decision: ['Problem'], task: ['Scope'] }[
      kind
    ] ?? []
  );
}

function fullNeed(kind: string, lifecycle: string): string[] {
  if (kind === 'decision' && lifecycle === 'implemented') {
    return ['Problem', 'Decision', 'Alternatives considered', 'Consequences'];
  }
  return (
    {
      idea: ['Background', 'Idea', 'Open questions'],
      initiative: ['Goal', 'Scope', 'Acceptance criteria'],
      requirement: ['Problem', 'Expected behavior', 'Scope', 'Acceptance criteria'],
      decision: ['Problem', 'Proposal', 'Alternatives considered', 'Risks'],
      task: ['Scope', 'Acceptance criteria', 'Verification'],
    }[kind] ?? []
  );
}

/** Structural validation (C1-C2, single file). Empty array means valid. */
export function validateNote(note: ParsedNote): Diagnostic[] {
  const out: Diagnostic[] = [];
  const m = note.meta;
  for (const k of Object.keys(note.unknownFields)) {
    out.push(diag('SCHEMA_INVALID', `unknown top-level key '${k}'`, k));
  }
  for (const k of ['schema', 'id', 'kind', 'lifecycle', 'created'] as const) {
    if (m[k] === undefined || m[k] === null || m[k] === '') {
      out.push(diag('SCHEMA_INVALID', `missing '${k}'`, k));
    }
  }
  if (typeof m.id !== 'string' || !UUID_RE.test(m.id)) out.push(diag('SCHEMA_INVALID', 'id must be lowercase UUID', 'id'));
  if (!isNoteKind(m.kind)) out.push(diag('SCHEMA_INVALID', 'bad kind', 'kind'));
  if (!isLifecycle(m.lifecycle)) out.push(diag('SCHEMA_INVALID', 'bad lifecycle', 'lifecycle'));
  if (m.kind !== 'decision' && m.lifecycle === 'implemented') {
    out.push(diag('SCHEMA_INVALID', 'implemented only for decision', 'lifecycle'));
  }
  if (typeof m.created !== 'string' || !DATE_RE.test(m.created)) {
    out.push(diag('SCHEMA_INVALID', 'created must be YYYY-MM-DD string', 'created'));
  }
  if (m.class !== undefined && m.class !== null) {
    const classes = ['feature', 'bug-fix', 'architecture', 'process', 'testing', 'simplification'];
    if (!classes.includes(String(m.class))) out.push(diag('SCHEMA_INVALID', 'bad class', 'class'));
  }
  if (m.tags !== undefined && m.tags !== null) {
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
      out.push(diag('SCHEMA_INVALID', 'tags must be string array', 'tags'));
    } else if (new Set(m.tags).size !== m.tags.length) {
      out.push(diag('SCHEMA_INVALID', 'duplicate tags', 'tags'));
    }
  }
  if (m.parent !== undefined && m.parent !== null && !NOTE_URI_RE.test(m.parent)) {
    out.push(diag('SCHEMA_INVALID', 'bad parent URI', 'parent'));
  }
  if (['rejected', 'archived'].includes(String(m.lifecycle))) {
    if (!m.disposition || typeof m.disposition.reason !== 'string' || !m.disposition.reason.trim()) {
      out.push(diag('SCHEMA_INVALID', 'disposition.reason required', 'disposition'));
    }
  } else if (m.disposition !== undefined) {
    out.push(diag('SCHEMA_INVALID', 'disposition forbidden unless rejected/archived', 'disposition'));
  }
  if (m.repositories !== undefined && m.repositories !== null) {
    const r = m.repositories;
    if (r.primary !== undefined && !UUID_RE.test(String(r.primary))) {
      out.push(diag('SCHEMA_INVALID', 'bad repositories.primary', 'repositories.primary'));
    }
    if (r.related !== undefined) {
      if (!Array.isArray(r.related)) out.push(diag('SCHEMA_INVALID', 'bad repositories.related', 'repositories.related'));
      else {
        for (const [i, x] of r.related.entries()) {
          if (!UUID_RE.test(String(x))) out.push(diag('SCHEMA_INVALID', 'bad related repoId', `repositories.related[${i}]`));
        }
        if (r.primary && r.related.map(String).includes(String(r.primary))) {
          out.push(diag('SCHEMA_INVALID', 'primary duplicated in related', 'repositories.related'));
        }
      }
    }
  }
  const rels = m.relations ?? [];
  if (!Array.isArray(rels)) out.push(diag('SCHEMA_INVALID', 'relations must be array', 'relations'));
  else {
    const seen = new Set<string>();
    rels.forEach((r, i) => {
      const at = `relations[${i}]`;
      if (!isRecord(r) || typeof r['type'] !== 'string' || typeof r['target'] !== 'string') {
        out.push(diag('SCHEMA_INVALID', 'relation needs type/target', at));
        return;
      }
      const rel = r as unknown as { type: string; target: string; criteria?: unknown; scope?: unknown; reason?: unknown };
      const types = ['parent', 'depends-on', 'implements', 'governed-by', 'derived-from', 'supersedes', 'related-to'];
      if (!types.includes(rel.type)) {
        out.push(diag('SCHEMA_INVALID', `bad relation type ${rel.type}`, `${at}.type`));
        return;
      }
      if (!NOTE_URI_RE.test(rel.target)) {
        out.push(diag('SCHEMA_INVALID', `bad relation target ${rel.target}`, `${at}.target`));
        return;
      }
      if (rel.target.endsWith('/' + m.id)) out.push(diag('INVALID_RELATION', 'self reference', `${at}.target`));
      const edge = `${rel.type}\u0000${rel.target}`;
      if (seen.has(edge)) out.push(diag('SCHEMA_INVALID', 'duplicate relation', at));
      seen.add(edge);
      if (rel.criteria !== undefined && rel.type !== 'implements') {
        out.push(diag('SCHEMA_INVALID', 'criteria only for implements', `${at}.criteria`));
      }
      if (rel.type === 'implements' && m.kind !== 'task') {
        out.push(diag('INVALID_RELATION', 'implements only from task', `${at}.type`));
      }
      if (rel.type === 'governed-by' && !['initiative', 'requirement', 'task'].includes(String(m.kind))) {
        out.push(diag('INVALID_RELATION', 'governed-by owner', `${at}.type`));
      }
      if (rel.type === 'depends-on' && !['requirement', 'task'].includes(String(m.kind))) {
        out.push(diag('INVALID_RELATION', 'depends-on owner', `${at}.type`));
      }
      if (Array.isArray(rel.criteria)) {
        for (const c of rel.criteria) {
          if (typeof c !== 'string' || !AC_ID_RE.test(c)) {
            out.push(diag('SCHEMA_INVALID', `bad criteria ${String(c)}`, `${at}.criteria`));
          }
        }
      }
      if (rel.type === 'supersedes') {
        if (rel.scope !== 'full' && rel.scope !== 'partial') {
          out.push(diag('SCHEMA_INVALID', 'supersedes needs scope', `${at}.scope`));
        }
        if (typeof rel.reason !== 'string' || !rel.reason.trim()) {
          out.push(diag('SCHEMA_INVALID', 'supersedes needs reason', `${at}.reason`));
        }
      } else if (rel.scope !== undefined || rel.reason !== undefined) {
        out.push(diag('SCHEMA_INVALID', 'scope/reason only for supersedes', at));
      }
    });
  }
  if (m.codeRefs !== undefined && m.codeRefs !== null) {
    if (!Array.isArray(m.codeRefs)) out.push(diag('SCHEMA_INVALID', 'codeRefs must be array', 'codeRefs'));
    else {
      m.codeRefs.forEach((c, i) => {
        const at = `codeRefs[${i}]`;
        if (!isRecord(c)) {
          out.push(diag('SCHEMA_INVALID', 'bad codeRef', at));
          return;
        }
        if (!UUID_RE.test(String(c['repoId'] ?? ''))) {
          out.push(diag('SCHEMA_INVALID', 'bad codeRefs.repoId', `${at}.repoId`));
        }
        const bp = badPath(c['path']);
        if (bp) out.push(diag('SCHEMA_INVALID', `bad codeRefs.path: ${bp}`, `${at}.path`));
        if (!['entry', 'implementation', 'test'].includes(String(c['role']))) {
          out.push(diag('SCHEMA_INVALID', 'bad codeRefs.role', `${at}.role`));
        }
      });
    }
  }
  const isTask = m.kind === 'task';
  if (m.work !== undefined && m.work !== null && !isTask) {
    out.push(diag('SCHEMA_INVALID', 'work only for task', 'work'));
  }
  if (m.execution !== undefined && m.execution !== null && !isTask) {
    out.push(diag('SCHEMA_INVALID', 'execution only for task', 'execution'));
  }
  if (isTask && m.lifecycle === 'draft' && m.execution !== undefined && m.execution !== null) {
    out.push(diag('SCHEMA_INVALID', 'draft must not carry execution', 'execution'));
  }
  if (isTask && m.lifecycle !== 'draft') {
    const w = m.work;
    if (!isRecord(w)) {
      out.push(diag('NOT_READY', 'task needs work before execution', 'work'));
    } else {
      const scope = w['scope'];
      if (!Array.isArray(scope) || scope.length < 1) {
        out.push(diag('SCHEMA_INVALID', 'work.scope required', 'work.scope'));
      } else {
        scope.forEach((s, i) => {
          const at = `work.scope[${i}]`;
          if (!isRecord(s) || !UUID_RE.test(String(s['repoId'] ?? ''))) {
            out.push(diag('SCHEMA_INVALID', 'bad work.scope.repoId', `${at}.repoId`));
          }
          const paths = (s as unknown as Record<string, unknown>)['paths'];
          if (!Array.isArray(paths) || paths.length < 1) {
            out.push(diag('SCHEMA_INVALID', 'work.scope.paths required', `${at}.paths`));
          } else {
            for (const p of paths) {
              if (typeof p !== 'string' || !p) {
                out.push(diag('SCHEMA_INVALID', 'empty scope path', `${at}.paths`));
              } else if (p !== './') {
                const bp = badPath(p.replace(/\/$/, '') || './');
                if (bp) out.push(diag('SCHEMA_INVALID', `bad scope path '${p}': ${bp}`, `${at}.paths`));
              }
            }
          }
        });
      }
      const refs = w['acceptanceRefs'];
      if (!Array.isArray(refs) || refs.length < 1) {
        out.push(diag('SCHEMA_INVALID', 'work.acceptanceRefs required', 'work.acceptanceRefs'));
      } else {
        refs.forEach((a, i) => {
          const at = `work.acceptanceRefs[${i}]`;
          if (!isRecord(a) || !NOTE_URI_RE.test(String(a['uri'] ?? ''))) {
            out.push(diag('SCHEMA_INVALID', 'bad acceptanceRefs.uri', `${at}.uri`));
          }
          if (!isRecord(a) || typeof a['criterionId'] !== 'string' || !AC_ID_RE.test(a['criterionId'])) {
            out.push(diag('SCHEMA_INVALID', 'bad acceptanceRefs.criterionId', `${at}.criterionId`));
          }
        });
      }
      const ver = w['verification'];
      if (!Array.isArray(ver) || ver.length < 1) {
        out.push(diag('SCHEMA_INVALID', 'work.verification required', 'work.verification'));
      } else {
        ver.forEach((v, i) => {
          const at = `work.verification[${i}]`;
          if (!isRecord(v)) {
            out.push(diag('SCHEMA_INVALID', 'bad verification entry', at));
            return;
          }
          if (!v['id'] || !v['kind'] || v['required'] === undefined || !v['repoId'] || v['cwd'] === undefined) {
            out.push(diag('SCHEMA_INVALID', 'bad verification entry', at));
            return;
          }
          if (v['kind'] === 'command' && (typeof v['program'] !== 'string' || !Array.isArray(v['args']))) {
            out.push(diag('SCHEMA_INVALID', 'command verification needs program/args', at));
          }
          if (v['kind'] === 'manual' && typeof v['description'] !== 'string') {
            out.push(diag('SCHEMA_INVALID', 'manual verification needs description', at));
          }
          if (typeof v['cwd'] === 'string' && v['cwd'] !== '.' && badPath(v['cwd'])) {
            out.push(diag('SCHEMA_INVALID', 'bad verification cwd', `${at}.cwd`));
          }
        });
      }
    }
  }
  if (isTask && m.execution !== undefined && m.execution !== null) {
    const e = m.execution;
    if (!isRecord(e)) out.push(diag('SCHEMA_INVALID', 'bad execution', 'execution'));
    else {
      for (const k of ['mode', 'state', 'baseline', 'attempt', 'receipts', 'closeout']) {
        if (e[k] === undefined) out.push(diag('SCHEMA_INVALID', `execution missing ${k}`, `execution.${k}`));
      }
      const b = e['baseline'];
      if (
        !isRecord(b) ||
        typeof b['taskContractHash'] !== 'string' ||
        !HEX64_RE.test(b['taskContractHash']) ||
        !Array.isArray(b['inputs'])
      ) {
        out.push(diag('SCHEMA_INVALID', 'bad execution.baseline', 'execution.baseline'));
      }
    }
  }
  const names = noteSectionNames(note);
  if (new Set(names).size !== names.length) out.push(diag('SCHEMA_INVALID', 'duplicate H2'));
  const need = m.lifecycle === 'draft' ? draftNeed(String(m.kind)) : fullNeed(String(m.kind), String(m.lifecycle));
  for (const s of need) {
    if (!names.includes(s)) out.push(diag('SCHEMA_INVALID', `missing section '${s}'`));
  }
  if (m.kind === 'decision' && m.lifecycle === 'implemented' && names.includes('Proposal')) {
    out.push(diag('SCHEMA_INVALID', 'implemented decision forbids Proposal'));
  }
  const seenAc = new Set<string>();
  for (const a of note.acs) {
    if (seenAc.has(a.id)) out.push(diag('SCHEMA_INVALID', `duplicate ${a.id}`));
    seenAc.add(a.id);
    if (!a.text) out.push(diag('SCHEMA_INVALID', `empty ${a.id}`));
  }
  if (m.lifecycle !== 'draft' && ['requirement', 'initiative'].includes(String(m.kind)) && note.acs.length < 1) {
    out.push(diag('SCHEMA_INVALID', 'at least one AC required'));
  }
  if (m.lifecycle !== 'draft' && m.kind === 'task') {
    const refs = isRecord(m.work) && Array.isArray(m.work['acceptanceRefs']) ? m.work['acceptanceRefs'].length : 0;
    if (note.acs.length < 1 && refs < 1) {
      out.push(diag('SCHEMA_INVALID', 'task needs body AC or acceptanceRefs'));
    }
  }
  return out;
}

/** H2 names in document order (AST view). */
export function noteSectionNames(note: ParsedNote): string[] {
  const bodyLf = note.body.replace(/\r\n/g, '\n');
  return modelBody(bodyLf).h2;
}
