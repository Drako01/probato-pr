import { readFile, stat } from 'node:fs/promises';
import type { WorkspaceIndex } from '../core/analyzer';
import { PathOutsideWorkspaceError, resolveInside } from '../core/paths';
import type { GitClient } from '../git/git-client';

/**
 * Repository file index backed by `git ls-files` (tracked + untracked, honoring .gitignore), so
 * dependency folders and build output are never scanned. The listing is computed once per review.
 */
export class GitWorkspaceIndex implements WorkspaceIndex {
  private files: Promise<string[]> | undefined;

  constructor(
    private readonly git: GitClient,
    private readonly root: string,
    private readonly maxFileBytes: number,
  ) {}

  async listFiles(filter: (path: string) => boolean): Promise<readonly string[]> {
    this.files ??= this.git
      .exec(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBytes: 64 * 1024 * 1024 })
      .then((out) => [...new Set(out.split('\0').filter((p) => p.length > 0))]);
    return (await this.files).filter(filter);
  }

  async read(path: string): Promise<string | undefined> {
    try {
      const absolute = await resolveInside(this.root, path);
      const info = await stat(absolute);
      return info.isFile() && info.size <= this.maxFileBytes ? await readFile(absolute, 'utf8') : undefined;
    } catch (error) {
      if (error instanceof PathOutsideWorkspaceError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
}
