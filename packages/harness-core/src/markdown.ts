/** Derived Markdown view only; raw source hashes belong to the file reader.
 * Note: .agents/notes/harness/storage/history/note-index-v1.md
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

export interface MarkdownHeading {
  depth: number;
  text: string;
  anchor: string;
  /** Line in the parsed body, not in the full frontmatter document. */
  line: number;
}

export interface MarkdownLink {
  destination: string;
  label: string;
  line: number;
}

export interface MarkdownView {
  headings: MarkdownHeading[];
  links: MarkdownLink[];
  excerpt: string;
}

function textOf(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  return 'children' in node ? node.children.map(textOf).join('') : '';
}

/** CommonMark links only: no bare URL extension, wiki syntax, or code scanning.
 * Heading anchors use lowercase Unicode letters/numbers/marks, spaces as hyphens,
 * and numeric suffixes for collisions. Hosts render these shared anchors.
 */
export function readMarkdownView(body: string): MarkdownView {
  const tree = fromMarkdown(body);
  const definitions = new Map<string, string>();
  const visit = (node: Nodes, fn: (node: Nodes) => void): void => {
    fn(node);
    if ('children' in node) for (const child of node.children) visit(child, fn);
  };
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  const headings: MarkdownHeading[] = [];
  const links: MarkdownLink[] = [];
  const anchors = new Set<string>();
  const prose: string[] = [];
  visit(tree, (node) => {
    const line = node.position?.start.line ?? 1;
    if (node.type === 'heading') {
      const text = textOf(node);
      const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
      let anchor = base;
      for (let suffix = 1; anchors.has(anchor); suffix += 1) anchor = `${base}-${suffix}`;
      anchors.add(anchor);
      headings.push({ depth: node.depth, text, anchor, line });
    }
    if (node.type === 'paragraph') prose.push(textOf(node));
    const destination = node.type === 'link' ? node.url
      : node.type === 'linkReference' ? definitions.get(node.identifier) : undefined;
    if (destination !== undefined) links.push({ destination, label: textOf(node), line });
  });
  const compact = prose.join(' ').replace(/\s+/g, ' ').trim();
  return { headings, links, excerpt: compact.length <= 240 ? compact : `${compact.slice(0, 239).trimEnd()}…` };
}
