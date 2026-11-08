import { lstat, mkdir, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { asError, throwCollected } from '../core/errors';
import { uniqueId } from '../core/ids';
import { isWithin, resolveInside } from '../core/paths';
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
    private readonly linkedModules: string[],
    private readonly dependencyRoot: string = repoRoot,
  ) {}

  static async create(git: GitClient, repoRoot: string, commit: string, checkDirectories: readonly string[] = [''], dependencyRoot: string = repoRoot): Promise<BaselineWorktree> {
    const parent = path.join(tmpdir(), 'probato-pr');
    await mkdir(parent, { recursive: true });
    const directory = path.join(parent, `baseline-${uniqueId()}`);
    await git.addDetachedWorktree(repoRoot, directory, commit);

    const worktree = new BaselineWorktree(git, repoRoot, directory, [], dependencyRoot);
    try {
      await worktree.linkDependencies(checkDirectories);
    } catch (error) {
      await worktree.dispose();
      throw error;
    }
    return worktree;
  }

  /** Also called after staged files introduce a new package directory into an isolated checkout. */
  async linkDependencies(checkDirectories: readonly string[]): Promise<void> {
    for (const cwd of new Set(['', ...checkDirectories])) {
      const source = path.resolve(this.dependencyRoot, cwd, 'node_modules');
      if (!isWithin(this.dependencyRoot, source)) throw new Error('Invalid baseline check directory.');
      const target = path.join(this.directory, cwd, 'node_modules');
      if (this.linkedModules.includes(target)) continue;
      let info;
      try { info = await lstat(source); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isDirectory()) continue;
      await assertNoHeadSourceLinks(source, this.dependencyRoot);
      const parentDirectory = await resolveInside(this.directory, cwd || '.');
      try { await lstat(parentDirectory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      // Never overwrite a dependency path that the reviewed revision tracked.
      const existing = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing) continue;
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      this.linkedModules.push(target);
    }
  }

  async dispose(): Promise<void> {
    for (const linked of this.linkedModules) {
      const info = await lstat(linked).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        await unlink(linked);
      } else if (info) {
        // Not a link (unexpected): refuse to delete anything rather than risk removing real dependencies.
        throw new Error(`Refusing to clean up ${this.directory}: node_modules is not the expected link.`);
      }
    }
    // Every cleanup step runs even when an earlier one fails: the temporary directory is deleted when Git
    // cannot unregister the worktree (locked, crashed, killed), stale registrations are then pruned, and
    // every failure is still reported (one as is, several as an AggregateError).
    const failures: Error[] = [];
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try { await step(); } catch (error) { failures.push(asError(error)); }
    };
    await attempt(() => this.git.removeWorktree(this.repoRoot, this.directory));
    await attempt(() => rm(this.directory, { recursive: true, force: true }));
    if (failures.length > 0) await attempt(() => this.git.pruneWorktrees(this.repoRoot));
    throwCollected(failures, `Could not fully clean up baseline worktree ${this.directory}.`);
  }
}

/** A workspace link into head source would make baseline evidence false. Dependencies are reused
 * only when their links stay in installed dependencies or outside this repository entirely. */
async function assertNoHeadSourceLinks(directory: string, root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const queue = [directory];
  let inspected = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++inspected > 100_000) throw new Error('Dependency-link scan limit reached; baseline comparability cannot be guaranteed.');
      const item = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(item).catch(() => undefined);
        if (target && isWithin(canonicalRoot, target) && !path.relative(canonicalRoot, target).split(path.sep).includes('node_modules')) {
          throw new Error(`Workspace dependency ${path.relative(root, item)} resolves into the head source; baseline attribution is inconclusive.`);
        }
      } else if (entry.isDirectory()) {
        queue.push(item);
      }
    }
  }
}
