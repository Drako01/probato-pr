import type { WorkspaceIndex } from '../core/analyzer';
import { isAsarPath, readSafeWorkspaceText } from './safe-text-reader';
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
      .then((out) => [...new Set(out.split('\0').filter((p) => p.length > 0 && !isAsarPath(p)))]);
    return (await this.files).filter(filter);
  }

  read(path: string): Promise<string | undefined> {
    return readSafeWorkspaceText(this.root, path, this.maxFileBytes);
  }
}
