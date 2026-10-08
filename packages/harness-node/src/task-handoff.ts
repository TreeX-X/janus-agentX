// Note: Main Agent owns Task handoffs — see .agents/notes/harness/workflowx-v2-adoption.md
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNote, serializeNote, setSection, taskContractHash } from '@janus-agent/harness-core';
import { buildNoteIndex, sha256HexBytes } from './repository.js';
import { withAssetLock, commitAssetFiles } from './transaction.js';

export async function checkpointTaskHandoff(root: string, uri: string, contract: string, action: string): Promise<void> {
  await withAssetLock(root, async () => {
    const index = await buildNoteIndex(root), entry = index.byUri.get(uri);
    if (!entry?.note) throw new Error('NOT_FOUND: handoff Task');
    if (entry.note.meta.schema !== 'harness-note/2') return;
    const raw = await readFile(join(root, entry.relPath), 'utf8'), note = parseNote(raw);
    if (taskContractHash(note) !== contract) throw new Error('STALE_BASELINE: handoff contract changed');
    const marker = /<!-- agentx-checkpoint -->[\s\S]*?<!-- agentx-checkpoint-end -->/g;
    // Remove only the old runtime-owned duplicates; authored evidence stays intact.
    for (const name of ['Progress', 'Evidence']) {
      const current = note.sections.find(s => s.name === name)?.text ?? '';
      const authored = current.replace(marker, '').trim();
      if (authored !== current.trim()) note.body = setSection(note.body, name,
        authored || (name === 'Progress' ? 'See execution for runtime state.' : 'See execution.receipts for formal evidence.'));
    }
    const current = note.sections.find(s => s.name === 'Handoff')?.text ?? '';
    const authored = current.replace(marker, '').trim();
    const block = `<!-- agentx-checkpoint -->\nNext: ${action}\n<!-- agentx-checkpoint-end -->`;
    note.body = setSection(note.body, 'Handoff', [authored, block].filter(Boolean).join('\n\n'));
    note.meta.updated = new Date().toISOString();
    await commitAssetFiles(root, [{path:entry.relPath,before:sha256HexBytes(Buffer.from(raw)),after:serializeNote(note)}]);
  });
}
