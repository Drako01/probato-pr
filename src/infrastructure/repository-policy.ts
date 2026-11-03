import { open } from 'node:fs/promises';
import type { WorkspaceIndex } from '../core/analyzer';
import { tr } from '../core/i18n';
import { resolveInside } from '../core/paths';
import { MAX_POLICY_BYTES, parseRepositoryPolicy, type RepositoryPolicy } from '../core/repository-policy';

export interface LoadedRepositoryPolicy { readonly policy?: RepositoryPolicy; readonly warnings: readonly string[] }

/** The supplied revision index always wins over disk; historical reviews never read working-tree policy. */
export async function loadRepositoryPolicy(root: string, workspace?: WorkspaceIndex): Promise<LoadedRepositoryPolicy> {
  try {
    let text: string | undefined;
    if (workspace) {
      text = await workspace.read('.probato.yml');
      if (text === undefined && (await workspace.listFiles((file) => file === '.probato.yml')).length) throw new Error(tr('Repository policy exists but could not be read within the safe limits.'));
    } else {
      const file = await open(await resolveInside(root, '.probato.yml'), 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_POLICY_BYTES) throw new Error(tr('Repository policy exceeds the {0}-byte limit.', MAX_POLICY_BYTES));
        const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_POLICY_BYTES) throw new Error(tr('Repository policy exceeds the {0}-byte limit.', MAX_POLICY_BYTES));
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    }
    if (text === undefined) return { warnings: [] };
    return { policy: parseRepositoryPolicy(text), warnings: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { warnings: [] };
    return { warnings: [tr('Repository policy was not applied: {0}', error instanceof Error ? error.message : String(error))] };
  }
}
