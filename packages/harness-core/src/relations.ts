/**
 * Graph rules over parsed notes (contract C2, multi-file half).
 * Single-file owner rules live in parse.ts; this module owns cycles,
 * the symmetric-edge owner rule, and unresolved-reference marking.
 */
import type { Diagnostic, ParsedNote, RelationType } from './schema.js';

function diag(code: Diagnostic['code'], message: string, path?: string): Diagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

export interface GraphNode {
  uri: string;
  note: ParsedNote;
}

const ACYCLIC: RelationType[] = ['parent', 'depends-on', 'derived-from', 'supersedes'];

function outEdges(node: GraphNode, type: RelationType): string[] {
  const out: string[] = [];
  const m = node.note.meta;
  if (type === 'parent' && m.parent) out.push(m.parent);
  for (const r of m.relations ?? []) if (r.type === type) out.push(r.target);
  return out;
}

/** Cycle check per edge class. Returns one diagnostic per class that closes a loop. */
export function checkAcyclic(nodes: GraphNode[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = new Map(nodes.map((n) => [n.uri, n]));
  for (const type of ACYCLIC) {
    const color = new Map<string, number>();
    const stack: string[] = [];
    let loop: string[] | null = null;
    const visit = (uri: string): void => {
      if (loop) return;
      color.set(uri, 1);
      stack.push(uri);
      const node = known.get(uri);
      if (node) {
        for (const next of outEdges(node, type)) {
          if (!known.has(next)) continue;
          const c = color.get(next) ?? 0;
          if (c === 0) visit(next);
          else if (c === 1) {
            loop = [...stack.slice(stack.indexOf(next)), next];
            return;
          }
          if (loop) return;
        }
      }
      stack.pop();
      color.set(uri, 2);
    };
    for (const n of nodes) {
      if ((color.get(n.uri) ?? 0) === 0) visit(n.uri);
      if (loop) break;
    }
    if (loop) out.push(diag('INVALID_RELATION', `${type} cycle: ${(loop as string[]).join(' -> ')}`));
  }
  return out;
}

/**
 * Symmetric edge rule: `related-to` is stored once, at the
 * lexicographically smaller full URI; the reverse derives at read time.
 */
export function relatedToOwner(aUri: string, bUri: string): string {
  return aUri < bUri ? aUri : bUri;
}

/** References whose target is absent stay `unresolved`, never forged (C2). */
export function unresolvedTargets(nodes: GraphNode[]): Array<{ from: string; target: string }> {
  const known = new Set(nodes.map((n) => n.uri));
  const out: Array<{ from: string; target: string }> = [];
  for (const n of nodes) {
    const targets = [...outEdges(n, 'parent')];
    for (const r of n.note.meta.relations ?? []) targets.push(r.target);
    for (const t of targets) {
      if (!known.has(t)) out.push({ from: n.uri, target: t });
    }
  }
  return out;
}

/**
 * Task start gate for requirement predecessors (C2): every task-side
 * predecessor needs effective done, every requirement-side predecessor
 * needs currently valid AC coverage. Evidence itself arrives via receipt.ts;
 * this helper only folds the caller-supplied verdicts.
 */
export function predecessorsSatisfied(
  deps: Array<{ kind: 'task' | 'requirement'; done: boolean; acCovered: boolean }>,
): { ok: boolean; blocking: number } {
  const blocking = deps.filter((d) => (d.kind === 'task' ? !d.done : !d.acCovered)).length;
  return { ok: blocking === 0, blocking };
}
