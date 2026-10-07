// Main Agent's runtime checkpoint; model workers never write execution ledgers.
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
    const execution = note.meta.execution;
    const update = (name: string, text: string) => {
      const current = note.sections.find(s => s.name === name)?.text ?? '';
      const marker = /<!-- agentx-checkpoint -->[\s\S]*?<!-- agentx-checkpoint-end -->/g;
      const block = `<!-- agentx-checkpoint -->\n${text}\n<!-- agentx-checkpoint-end -->`;
      note.body = setSection(note.body, name, marker.test(current) ? current.replace(marker, block) : `${current.trim()}\n\n${block}`.trim());
    };
    update('Handoff', `${action}\n\nTask: ${uri}\nContract: ${contract}\nAttempt: ${execution?.attempt ?? 0}. Re-read the current checkout and fixed inputs before proceeding. Main Agent owns this Task.`);
    update('Progress', `Execution state: ${execution?.state ?? 'not started'}. Next: ${action}. Implementation reports remain unverified until formal checks and review pass.`);
    update('Evidence', execution?.receipts.length ? `Recorded receipts: ${execution.receipts.join(', ')}. Resolve under .agents/evidence and verify against the current baseline; presence alone does not prove validity.` : 'No completed formal receipt yet. Use the fixed baseline and current run checks; do not infer completion.');
    note.meta.updated = new Date().toISOString();
    await commitAssetFiles(root, [{path:entry.relPath,before:sha256HexBytes(Buffer.from(raw)),after:serializeNote(note)}]);
  });
}
