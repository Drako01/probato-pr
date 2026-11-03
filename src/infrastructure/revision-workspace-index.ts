import type { WorkspaceIndex } from '../core/analyzer';
import type { GitClient } from '../git/git-client';

/** Cross-file analysis reads the same index/commit as the diff, independently of the working tree. */
export class RevisionWorkspaceIndex implements WorkspaceIndex {
  private listing: Promise<string[]> | undefined;
  constructor(private readonly git: GitClient, private readonly root: string, private readonly revision: string, private readonly maxBytes: number) {}
  async listFiles(filter: (file: string) => boolean): Promise<readonly string[]> {
    this.listing ??= this.git.exec(this.root, this.revision === '' ? ['ls-files', '--cached', '-z'] : ['ls-tree', '-r', '--name-only', '-z', this.revision], { maxBytes: 64 * 1024 * 1024 }).then((s) => [...new Set(s.split('\0').filter(Boolean))]);
    return (await this.listing).filter(filter);
  }
  read(file: string): Promise<string | undefined> { return this.git.readBlob(this.root, this.revision, file, this.maxBytes); }
}
