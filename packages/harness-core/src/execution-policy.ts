// Note: hosts share role identity and review policy — see .agents/notes/implemented/architecture/2026-09-19-delegated-task-hosts.md
import type { Receipt } from './receipt.js';

// The manifest supplies file discovery; direct reads cannot traverse local histories.
export const INDEPENDENT_REVIEW_TOOLS = ['workspace.read'];
export function isIndependentReviewPath(path: string): boolean {
  return !path.replace(/\\/g, '/').toLowerCase().split('/').some((part) => ['.agents', '.git', '.janusx'].includes(part));
}

export function taskExecutionPolicy(mode: Receipt['mode'], owner: string, runId: string) {
  const implementor = mode === 'xdo' ? owner : `${owner}:implementor:${runId}`;
  return {
    implementor,
    reviewer: `${owner}:evaluator:${runId}`,
    independent: mode === 'xflow',
    autoRepair: mode !== 'xdel',
  };
}
