import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { type Receipt, type WorkContract } from '@janus-agent/harness-core';
import { runGit } from './git-evidence.js';
import { sha256HexBytes } from './repository.js';

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function localPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (clean === '.') return clean;
  if (clean.split('/').some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f:*?\[\]{}<>|]/.test(part) || /[. ]$/.test(part))) {
    throw new Error(`CAPABILITY_UNAVAILABLE: scope requires literal relative paths: ${path}`);
  }
  return clean;
}

function protectedPath(path: string): boolean {
  const key = pathKey(path);
  return key.split('/').includes('.git') || key === '.agents' || key.startsWith('.agents/') || key === pathKey('.janusX/logs') || key.startsWith(pathKey('.janusX/logs/'));
}

/** Literal file/directory scopes; links and ledger writes are never model capabilities. */
export class TaskScope {
  readonly paths: string[];
  constructor(readonly root: string, readonly repoId: string, work: WorkContract) {
    if (work.scope.some((scope) => scope.repoId !== repoId)) throw new Error('CAPABILITY_UNAVAILABLE: multi-repository task execution needs a checkout resolver');
    this.paths = work.scope.flatMap((scope) => scope.paths.map(localPath));
  }

  includes(path: string): boolean {
    const target = pathKey(localPath(path));
    return this.paths.some((path) => {
      const scope = pathKey(path);
      return scope === '.' || target === scope || target.startsWith(`${scope}/`);
    });
  }

  async checkPath(path: string, mutation = false): Promise<void> {
    const clean = localPath(path);
    if (mutation && (clean === '.' || protectedPath(clean) || !this.includes(clean))) throw new Error(`OUTSIDE_WORKSPACE: task cannot modify ${path}`);
    if (mutation && runGit(this.root, ['check-ignore', '-q', '--', clean]).ok) throw new Error(`CAPABILITY_UNAVAILABLE: ignored files cannot enter task evidence: ${path}`);
    const root = await realpath(this.root);
    let current = root;
    const parts = clean === '.' ? [] : clean.split('/');
    for (const [i, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`CAPABILITY_UNAVAILABLE: task paths cannot traverse links: ${path}`);
      if (mutation && i === parts.length - 1 && (!stat.isFile() || stat.nlink > 1)) throw new Error(`CAPABILITY_UNAVAILABLE: task mutations require ordinary files: ${path}`);
    }
  }

  async manifest(): Promise<Receipt['codeManifest']> {
    const files = runGit(this.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!files.ok) throw new Error(`CAPABILITY_UNAVAILABLE: Git file enumeration failed: ${files.error}`);
    const rows: Receipt['codeManifest'] = [];
    for (const path of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
      if (protectedPath(path) || !this.includes(path)) continue;
      await this.checkPath(path);
      try {
        const stat = await lstat(join(this.root, path));
        if (!stat.isFile() || stat.nlink > 1) throw new Error(`CAPABILITY_UNAVAILABLE: manifest requires ordinary files: ${path}`);
        rows.push({ repoId: this.repoId, path, sha256: sha256HexBytes(await readFile(join(this.root, path))) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        rows.push({ repoId: this.repoId, path, deleted: true });
      }
    }
    return rows;
  }
}
