// Note: v2 module ownership is shared by scans and transactional post-image checks.
import { posix } from 'node:path';
import type { Diagnostic, ParsedNote } from '@janus-agent/harness-core';
import {readMarkdownView} from '@janus-agent/harness-core';

export function validateModuleStructure(entries: Array<{relPath: string; note?: ParsedNote}>, repoId: string | null): Diagnostic[] {
  const rows = entries.filter((e): e is {relPath: string; note: ParsedNote} => e.note?.meta.schema === 'harness-note/2');
  if (!rows.length || !repoId) return [];
  const errors: Diagnostic[] = [];
  const byPath = new Map(rows.map(e => [e.relPath, e]));
  const byUri = new Map(rows.map(e => [`note://${repoId}/${e.note.meta.id}`, e]));
  const fail = (path: string, message: string) => errors.push({code: 'SCHEMA_INVALID', path, message});
  const paths = new Set<string>();
  for (const entry of rows) { const key=entry.relPath.toLowerCase(); if(paths.has(key)) fail(entry.relPath,'duplicate or case-colliding module path'); paths.add(key); }
  const nearest = (dir: string): string | undefined => {
    while (dir === '.agents/notes' || dir.startsWith('.agents/notes/')) {
      const owner = byPath.get(dir + '/module.md');
      if (owner?.note.meta.kind === 'module') return `note://${repoId}/${owner.note.meta.id}`;
      dir = posix.dirname(dir);
    }
    return undefined;
  };
  const root = byPath.get('.agents/notes/module.md');
  if (root?.note.meta.kind !== 'module' || root.note.meta.role !== 'project') fail('.agents/notes/module.md', 'v2 needs one project module entry');
  for (const {relPath, note} of rows) {
    const meta = note.meta, dir = posix.dirname(relPath);
    if (/^\d{4}-\d{2}-\d{2}-/.test(posix.basename(relPath))) fail(relPath, 'v2 requires stable subject filenames');
    if (meta.kind === 'module') {
      if (posix.basename(relPath) !== 'module.md') fail(relPath, 'module entry must be module.md');
      if (dir === '.agents/notes') { if (meta.parent || meta.role !== 'project') fail(relPath, 'project module has no parent'); }
      else if (meta.parent !== nearest(posix.dirname(dir)) || !meta.parent) fail(relPath, 'module parent must match enclosing module');
    } else if (!meta.module || meta.module !== nearest(dir)) fail(relPath, 'document ownership must match enclosing module');
    for (const uri of [meta.parent, meta.module, ...(meta.relations ?? []).map(r => r.target), ...(meta.work?.acceptanceRefs ?? []).map(r => r.uri)].filter((v): v is string => !!v)) {
      if (uri.startsWith(`note://${repoId}/`) && !byUri.has(uri)) fail(relPath, `missing local Note ${uri}`);
    }
    for (const ref of meta.work?.acceptanceRefs ?? []) {
      const target = byUri.get(ref.uri);
      if (target && !target.note.acs.some(a => a.id === ref.criterionId)) fail(relPath, `missing acceptance ${ref.uri}#${ref.criterionId}`);
    }
    for (const link of readMarkdownView(note.body).links) {
      const dest=link.destination.split('#')[0];
      if (dest.startsWith(`note://${repoId}/`) && !byUri.has(dest)) fail(relPath,`missing Markdown Note target ${dest}`);
      if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
      let target: string;
      try { target=posix.normalize(posix.join(dir,decodeURIComponent(dest))); } catch { fail(relPath,'invalid Markdown destination'); continue; }
      if(target.startsWith('.agents/notes/') && target.endsWith('.md') && !entries.some(e=>e.relPath===target)) fail(relPath,`missing Markdown file ${dest}; repair references in the same transaction`);
    }
  }
  return errors;
}
