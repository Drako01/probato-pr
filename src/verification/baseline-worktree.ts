import { lstat, mkdir, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { uniqueId } from '../core/ids';
import type { GitClient } from '../git/git-client';

/**
 * Temporary detached git worktree at the base revision, used to re-run a failing check and
 * attribute the failure. The user's working tree is never touched.
 *
 * node_modules is linked (junction on Windows, symlink elsewhere) to the main checkout so the
 * baseline uses the same installed dependencies without installing anything. The link is removed
 * with unlink() before the worktree is deleted, so a recursive delete can never reach the real folder.
 */
export class BaselineWorktree {
  private constructor(
    private readonly git: GitClient,
    private readonly repoRoot: string,
    readonly directory: string,
    private readonly linkedModules: string | undefined,
  ) {}

  static async create(git: GitClient, repoRoot: string, commit: string): Promise<BaselineWorktree> {
    const parent = path.join(tmpdir(), 'probato-pr');
    await mkdir(parent, { recursive: true });
    const directory = path.join(parent, `baseline-${uniqueId()}`);
    await git.addDetachedWorktree(repoRoot, directory, commit);

    let linkedModules: string | undefined;
    const source = path.join(repoRoot, 'node_modules');
    try {
      if ((await lstat(source)).isDirectory()) {
        linkedModules = path.join(directory, 'node_modules');
        await symlink(source, linkedModules, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await new BaselineWorktree(git, repoRoot, directory, undefined).dispose();
        throw error;
      }
      linkedModules = undefined;
    }
    return new BaselineWorktree(git, repoRoot, directory, linkedModules);
  }

  async dispose(): Promise<void> {
    if (this.linkedModules) {
      const info = await lstat(this.linkedModules).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        await unlink(this.linkedModules);
      } else if (info) {
        // Not a link (unexpected): refuse to delete anything rather than risk removing real dependencies.
        throw new Error(`Refusing to clean up ${this.directory}: node_modules is not the expected link.`);
      }
    }
    await this.git.removeWorktree(this.repoRoot, this.directory);
    await rm(this.directory, { recursive: true, force: true });
  }
}
