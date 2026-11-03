import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ReviewScope } from '../core/model';
import { assertSafeRef, type GitClient } from '../git/git-client';
import { BaselineWorktree } from './baseline-worktree';

/** Materializes the exact reviewed commit or index without changing the user's checkout. The caller
 * guards repository snapshots before and after creation, then plans checks in this directory. */
export class ReviewedWorktree {
  private constructor(private readonly worktree: BaselineWorktree) {}

  get directory(): string { return this.worktree.directory; }

  static async create(git: GitClient, root: string, scope: ReviewScope, checkDirectories: readonly string[] = []): Promise<ReviewedWorktree> {
    if (scope.headIsWorkingTree) throw new Error('Working-tree reviews must run against their guarded original snapshot.');
    const revision = scope.kind === 'staged' ? scope.baseSha : scope.headSha;
    if (!revision) throw new Error('The reviewed revision is unavailable for isolated verification.');
    const worktree = await BaselineWorktree.create(git, root, assertSafeRef(revision), checkDirectories);
    try {
      if (scope.kind === 'staged') {
        const patch = await git.exec(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
          '--src-prefix=a/', '--dst-prefix=b/', assertSafeRef(revision), '--'], { maxBytes: 64 * 1024 * 1024 });
        if (patch.length > 0) {
          const patchDirectory = await mkdtemp(path.join(tmpdir(), 'probato-index-'));
          try {
            const patchFile = path.join(patchDirectory, 'review.patch');
            await writeFile(patchFile, patch, { encoding: 'utf8', mode: 0o600 });
            await git.execWithoutCheckoutCode(worktree.directory, ['apply', '--index', '--binary', '--', patchFile], { maxBytes: 64 * 1024 * 1024 });
          } finally {
            await rm(patchDirectory, { recursive: true, force: true });
          }
        }
        await worktree.linkDependencies(checkDirectories);
      }
      return new ReviewedWorktree(worktree);
    } catch (error) {
      await worktree.dispose();
      throw error;
    }
  }

  linkDependencies(checkDirectories: readonly string[]): Promise<void> { return this.worktree.linkDependencies(checkDirectories); }
  dispose(): Promise<void> { return this.worktree.dispose(); }
}
