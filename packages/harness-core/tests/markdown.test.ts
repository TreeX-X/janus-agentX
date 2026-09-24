import { describe, expect, it } from 'vitest';
import { readMarkdownView } from '../src/index.js';

describe('shared Markdown view', () => {
  it('extracts inline, reference and autolinks while ignoring code and bare/wiki text', () => {
    const uri = 'note://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const body = [
      '# A title', `[inline](${uri}#scope) [reference][REF] <${uri}>`,
      '', `[ref]: ${uri}`, '', uri, '[[A title]]',
      '', `\`[code](${uri})\``, '', '```md', `[fenced](${uri})`, '```',
      '', `    [indented](${uri})`, '', `![image](${uri})`,
    ].join('\n');
    expect(readMarkdownView(body).links.map((link) => link.destination)).toEqual([`${uri}#scope`, uri, uri]);
  });

  it('shares Unicode heading anchors, collision suffixes and bounded excerpts', () => {
    const view = readMarkdownView('# Title\n\n## **设计** `API`!\n\n## 设计 API\n\n## 设计 API-1\n\n' + 'word '.repeat(100));
    expect(view.headings.map((heading) => heading.anchor)).toEqual(['title', '设计-api', '设计-api-1', '设计-api-1-1']);
    expect(view.excerpt).toHaveLength(240);
    expect(view.excerpt.endsWith('…')).toBe(true);
  });
});
