/** Read-side reference resolution in one explicitly selected checkout.
 * Note: .agents/notes/2026-09-24-note-index-v1--4f6c2a91.md
 */
import { posix } from 'node:path';
import { NOTE_URI_RE, UUID_RE, type Diagnostic, type MarkdownLink } from '@janus-agent/harness-core';
import type { IndexEntry, NoteIndex } from './repository.js';

export interface NoteResolution {
  status: 'resolved' | 'unavailable' | 'missing' | 'ambiguous' | 'invalid';
  reason?: 'unbound-repository' | 'incomplete-scan' | 'unreadable-file';
  targetPath?: string;
  sourceHash?: string;
  anchorStatus?: 'resolved' | 'missing' | 'unavailable' | 'invalid';
  diagnostics: Diagnostic[];
}

export interface IndexedMention {
  sourceUri: string;
  targetUri?: string;
  anchor?: string;
  destinations: string[];
  occurrences: MarkdownLink[];
  resolution: NoteResolution;
}

function problem(status: NoteResolution['status'], code: Diagnostic['code'], message: string, reason?: NoteResolution['reason']): NoteResolution {
  return { status, ...(reason ? { reason } : {}), diagnostics: [{ code, message }] };
}

/** This index never searches another worktree/repository or chooses a checkout. */
export function resolveNoteReference(index: NoteIndex, uri: string): NoteResolution {
  const parts = uri.slice(7).split('/');
  if (!NOTE_URI_RE.test(uri) || !parts.every((part) => UUID_RE.test(part))) {
    return problem('invalid', 'SCHEMA_INVALID', `invalid Note URI: ${uri}`);
  }
  if (!index.repoId || parts[0] !== index.repoId) {
    return problem('unavailable', 'NOT_READY', `repository not bound in this index: ${parts[0]}`, 'unbound-repository');
  }
  if (index.conflicts.has(parts[1])) return problem('ambiguous', 'CONFLICT', `conflicting Note identity: ${uri}`);
  const entry = index.byId.get(parts[1]);
  if (entry) {
    if (entry.classification !== 'valid') return problem('invalid', 'SCHEMA_INVALID', `invalid Note target: ${entry.relPath}`);
    return { status: 'resolved', targetPath: entry.relPath, sourceHash: entry.sourceHash!, diagnostics: [] };
  }
  return absent(index, uri);
}

function absent(index: NoteIndex, target: string): NoteResolution {
  return index.coverage.status === 'complete'
    ? problem('missing', 'NOT_FOUND', `Note target missing from complete scan: ${target}`)
    : problem('unavailable', 'NOT_READY', `Note target not known in incomplete scan: ${target}`, 'incomplete-scan');
}

function resolveDestination(index: NoteIndex, source: IndexEntry, destination: string): { targetUri?: string; anchor?: string; resolution: NoteResolution } | undefined {
  const hash = destination.indexOf('#');
  const target = hash < 0 ? destination : destination.slice(0, hash);
  let anchor = hash < 0 ? undefined : destination.slice(hash + 1);
  let invalidAnchor = false;
  if (anchor !== undefined) {
    try { anchor = decodeURIComponent(anchor); } catch { invalidAnchor = true; }
  }
  let targetUri: string | undefined;
  let resolution: NoteResolution;
  if (/^note:/i.test(target)) {
    targetUri = target;
    resolution = resolveNoteReference(index, target);
  } else {
    // External URLs, rooted paths and other files retain their ordinary link meaning.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.includes('?')) return undefined;
    let path: string;
    try { path = decodeURIComponent(target); } catch {
      if (!target.toLowerCase().endsWith('.md')) return undefined;
      return { ...(anchor !== undefined ? { anchor } : {}), resolution: problem('invalid', 'SCHEMA_INVALID', `invalid relative destination: ${destination}`) };
    }
    if (path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) return undefined;
    const relPath = path ? posix.normalize(posix.join(posix.dirname(source.relPath), path)) : source.relPath;
    const entry = index.byPath.get(relPath);
    if (!entry && (!relPath.startsWith('.agents/notes/') || !relPath.toLowerCase().endsWith('.md'))) return undefined;
    if (entry?.foreign) return undefined;
    if (entry?.note) {
      targetUri = index.repoId ? `note://${index.repoId}/${entry.note.meta.id}` : undefined;
      resolution = targetUri ? resolveNoteReference(index, targetUri)
        : problem('unavailable', 'NOT_READY', 'source repository is unbound', 'unbound-repository');
    } else if (entry) {
      resolution = entry.classification === 'unreadable'
        ? problem('unavailable', 'IO_ERROR', `target file unreadable: ${relPath}`, 'unreadable-file')
        : problem('invalid', 'SCHEMA_INVALID', `malformed Note target: ${relPath}`);
    } else resolution = absent(index, relPath);
  }
  if (anchor !== undefined) {
    if (invalidAnchor) {
      resolution.anchorStatus = 'invalid';
      resolution.diagnostics.push({ code: 'SCHEMA_INVALID', message: `invalid section fragment: ${anchor}` });
    } else if (resolution.status !== 'resolved') resolution.anchorStatus = 'unavailable';
    else {
      const view = resolution.targetPath ? index.byPath.get(resolution.targetPath)?.view : undefined;
      const exists = anchor === '' || view?.headings.some((heading) => heading.anchor === anchor);
      resolution.anchorStatus = exists ? 'resolved' : 'missing';
      if (!exists) resolution.diagnostics.push({ code: 'UNRESOLVED_REFERENCE', message: `section missing: ${targetUri}#${anchor}` });
    }
  }
  return { ...(targetUri ? { targetUri } : {}), ...(anchor !== undefined ? { anchor } : {}), resolution };
}

/** Deduplicate the display edge while retaining every parsed occurrence/destination. */
export function deriveMentions(index: NoteIndex): IndexedMention[] {
  const mentions = new Map<string, IndexedMention>();
  for (const [sourceUri, source] of index.byUri) {
    for (const link of source.view?.links ?? []) {
      const target = resolveDestination(index, source, link.destination);
      if (!target) continue;
      const key = JSON.stringify([sourceUri, target.targetUri ?? link.destination, target.anchor]);
      const existing = mentions.get(key);
      if (existing) {
        if (!existing.destinations.includes(link.destination)) existing.destinations.push(link.destination);
        existing.occurrences.push(link);
      } else mentions.set(key, { sourceUri, ...target, destinations: [link.destination], occurrences: [link] });
    }
  }
  return [...mentions.values()];
}
