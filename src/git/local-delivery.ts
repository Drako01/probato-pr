import { tr } from '../core/i18n';
import { SENSITIVE_FILE_GLOBS } from '../core/secrets';
import { matchesAnyGlob } from '../core/glob';
import { resolveInside } from '../core/paths';
import type { GitClient } from './git-client';

/** Explicit user actions only. Never force-push, discard changes or bypass commit hooks. */
export class LocalDelivery {
  constructor(private readonly git: GitClient) {}
  async createBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.git.exec(root, ['check-ref-format', '--branch', branch], { ...(signal ? { signal } : {}) });
    await this.git.exec(root, ['switch', '-c', branch], { ...(signal ? { signal } : {}) });
  }
  async switchBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.git.exec(root, ['check-ref-format', '--branch', branch], { ...(signal ? { signal } : {}) });
    await this.git.exec(root, ['switch', '--', branch], { ...(signal ? { signal } : {}) });
  }
  async stage(root: string, files: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!files.length) return;
    for (const file of files) {
      await resolveInside(root, file);
      if (matchesAnyGlob(file, SENSITIVE_FILE_GLOBS)) throw new Error(tr('Sensitive files cannot be staged by Probato PR: {0}', file));
    }
    await this.git.exec(root, ['--literal-pathspecs', 'add', '--', ...files], { ...(signal ? { signal } : {}) });
  }
  async commit(root: string, message: string, signal?: AbortSignal): Promise<void> {
    if (!message.trim()) throw new Error(tr('Enter a commit message.'));
    const staged = await this.git.diff(root, ['--cached', '--name-only']);
    if (!staged.trim()) throw new Error(tr('Stage files before committing.'));
    await this.git.exec(root, ['commit', '-m', message], { ...(signal ? { signal } : {}) });
  }
  async push(root: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const branch = await this.git.currentBranch(root);
    if (!branch) throw new Error(tr('Create or switch to a branch before pushing.'));
    await this.git.exec(root, ['check-ref-format', '--branch', branch], { ...(signal ? { signal } : {}) });
    const head = await this.git.resolveCommit(root, 'HEAD');
    if (!head) throw new Error(tr('Create or switch to a branch before pushing.'));
    await this.git.exec(root, ['push', '--set-upstream', 'origin', `${head}:refs/heads/${branch}`], { ...(signal ? { signal } : {}) });
    await this.git.exec(root, ['config', '--local', `branch.${branch}.remote`, 'origin'], { ...(signal ? { signal } : {}) });
    await this.git.exec(root, ['config', '--local', `branch.${branch}.merge`, `refs/heads/${branch}`], { ...(signal ? { signal } : {}) });
  }
  async synchronize(root: string, signal?: AbortSignal): Promise<void> {
    const status = await this.git.exec(root, ['status', '--porcelain', '--untracked-files=all'], { ...(signal ? { signal } : {}) });
    if (status.trim()) throw new Error(tr('Commit or stash local changes before synchronizing.'));
    await this.git.exec(root, ['pull', '--ff-only'], { ...(signal ? { signal } : {}) });
  }
  async deleteMergedBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.git.exec(root, ['check-ref-format', '--branch', branch], { ...(signal ? { signal } : {}) });
    await this.git.exec(root, ['branch', '-d', '--', branch], { ...(signal ? { signal } : {}) });
  }
}
