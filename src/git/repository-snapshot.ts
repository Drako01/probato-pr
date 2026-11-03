import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { mapLimit } from '../core/concurrency';
import { tr } from '../core/i18n';
import type { ReviewResult } from '../core/model';
import { resolveInside } from '../core/paths';
import type { GitClient } from './git-client';

export interface RepositorySnapshot {
  readonly fingerprint: string;
  readonly headSha: string | undefined;
  readonly branch: string | undefined;
  readonly dirty: boolean;
}

/** Identity includes index, branch, HEAD and every tracked/untracked nonignored file, never its plaintext. */
export async function repositorySnapshot(git: GitClient, root: string, signal?: AbortSignal): Promise<RepositorySnapshot> {
  const options = { maxBytes: 64 * 1024 * 1024, ...(signal ? { signal } : {}) };
  const [headSha, branch, index, listed, status] = await Promise.all([
    git.resolveCommit(root, 'HEAD'), git.currentBranch(root),
    git.exec(root, ['ls-files', '--stage', '-z'], options),
    git.exec(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options),
    git.exec(root, ['status', '--porcelain', '-z', '--untracked-files=all'], options),
  ]);
  const names = [...new Set(listed.split('\0').filter(Boolean))].sort();
  if (names.length > 100_000) throw new Error(tr('Repository snapshot exceeds the 100000-file safety limit.'));
  let bytes = 0;
  const entries = await mapLimit(names, 8, async (name) => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    // lstat does not follow a link: hash its target text, never data outside the repository.
    const absolute = path.join(root, name);
    const info = await lstat(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return [name, 'deleted'];
    if (info.isSymbolicLink()) return [name, 'link', await readlink(absolute)];
    if (!info.isFile()) return [name, 'directory'];
    bytes += info.size;
    if (bytes > 512 * 1024 * 1024) throw new Error(tr('Repository snapshot exceeds the 512 MiB safety limit.'));
    const hash = createHash('sha256');
    const stream = createReadStream(await resolveInside(root, name));
    const abort = () => stream.destroy(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
      signal?.removeEventListener('abort', abort);
      stream.destroy();
    }
    return [name, info.mode & 0o111, hash.digest('hex')];
  }, signal);
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return { fingerprint: createHash('sha256').update(JSON.stringify([headSha, branch, index, entries])).digest('hex'), headSha, branch, dirty: status.length > 0 };
}

/** Fail closed rather than attach current-checkout evidence to another commit or index snapshot. */
export async function assertReviewCurrent(git: GitClient, review: ReviewResult, signal?: AbortSignal, requireMatchingCheckout = true): Promise<RepositorySnapshot> {
  if (!review.repository.root || !review.snapshot) throw new Error(tr('Run a new local review before verifying or publishing evidence.'));
  const current = await repositorySnapshot(git, review.repository.root, signal);
  if (current.fingerprint !== review.snapshot) throw new Error(tr('Repository content changed since this review. Review the changes again.'));
  if (requireMatchingCheckout && !review.scope.headIsWorkingTree) {
    if (review.scope.kind === 'staged') {
      const unstaged = await git.diff(review.repository.root, [], { ...(signal ? { signal } : {}) });
      if (unstaged || (await git.untrackedFiles(review.repository.root)).length > 0) {
        throw new Error(tr('Staged verification requires the working tree to match the index, with no untracked files.'));
      }
    } else if (current.headSha !== review.scope.headSha || current.dirty) {
      throw new Error(tr('Check out the reviewed commit with a clean working tree before verifying or publishing evidence.'));
    }
  }
  return current;
}
