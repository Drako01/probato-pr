import { tr } from '../core/i18n';
import type { ChangeSet, ChangeSide, ChangeStatus, FileChange, RepositoryInfo } from '../core/model';
import { parseUnifiedDiff } from '../git/diff-parser';
import { applyLimits, type ReviewLimits } from '../git/local-changes';
import type { GitHubClient, GitHubRepoRef, PullFile, PullRequest } from './github-client';

const STATUS: Readonly<Record<PullFile['status'], ChangeStatus>> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'type-changed',
  unchanged: 'modified',
};

/** Converts a GitHub PR file entry (patch = hunks only) into the domain FileChange. */
export function toFileChange(file: PullFile): FileChange {
  const status = STATUS[file.status];
  const hunks = file.patch ? (parseUnifiedDiff(`diff --git a/${file.filename} b/${file.filename}\n--- a/x\n+++ b/x\n${file.patch}\n`)[0]?.hunks ?? []) : [];
  return {
    path: file.filename,
    ...(file.previous_filename ? { oldPath: file.previous_filename } : {}),
    status,
    // GitHub omits the patch for binary files and very large diffs; content is then not analyzed.
    binary: file.patch === undefined && (file.additions > 0 || file.deletions > 0),
    hunks,
    additions: file.additions,
    deletions: file.deletions,
  };
}

/**
 * Builds a change set from the GitHub API without touching the local repository (read-only:
 * no fetch, checkout or worktree). File contents are fetched lazily and cached.
 */
export async function pullRequestChangeSet(
  client: GitHubClient,
  ref: GitHubRepoRef,
  pull: PullRequest,
  limits: ReviewLimits,
  repository: RepositoryInfo,
  signal?: AbortSignal,
): Promise<ChangeSet> {
  const files = (await client.listPullFiles(ref, pull.number, signal)).filter((f) => f.status !== 'unchanged').map(toFileChange);
  const limited = applyLimits(files, limits);
  const oldPaths = new Map(limited.files.filter((f) => f.oldPath).map((f) => [f.path, f.oldPath ?? f.path]));
  const cache = new Map<string, Promise<string | undefined>>();

  return {
    scope: {
      kind: 'pull-request',
      label: tr('pull request #{0}: {1}', pull.number, pull.title),
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      headIsWorkingTree: false,
      pullRequest: { owner: ref.owner, repo: ref.repo, number: pull.number, url: pull.html_url },
    },
    repository,
    files: limited.files,
    skipped: limited.skipped,
    content: {
      read: (path: string, side: ChangeSide) => {
        const key = `${side}:${path}`;
        let pending = cache.get(key);
        if (!pending) {
          const sha = side === 'base' ? pull.base.sha : pull.head.sha;
          const filePath = side === 'base' ? (oldPaths.get(path) ?? path) : path;
          pending = client.getFileContent(ref, filePath, sha, limits.maxFileBytes, signal);
          cache.set(key, pending);
        }
        return pending;
      },
    },
  };
}
