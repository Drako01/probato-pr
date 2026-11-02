import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { matchesAnyGlob } from '../core/glob';
import { tr } from '../core/i18n';
import type { ChangeSet, ChangeSide, ContentProvider, FileChange, ReviewScope, SkippedFile } from '../core/model';
import { PathOutsideWorkspaceError, resolveInside } from '../core/paths';
import { EMPTY_TREE_SHA, GitError, type GitClient } from './git-client';
import { parseUnifiedDiff, untrackedFileChange } from './diff-parser';

export interface ReviewLimits {
  readonly maxFiles: number;
  readonly maxDiffBytes: number;
  readonly maxFileBytes: number;
  readonly exclude: readonly string[];
}

export type LocalReviewRequest =
  | { readonly kind: 'working' }
  | { readonly kind: 'staged' }
  | { readonly kind: 'branch'; readonly baseBranch: string }
  | { readonly kind: 'commit'; readonly ref: string };

export class NoChangesError extends Error {
  constructor(readonly scopeLabel: string) {
    super(`No changes found for ${scopeLabel}.`);
    this.name = 'NoChangesError';
  }
}

/** Applies exclusion globs and the file-count limit; everything left out is reported, never dropped silently. */
export function applyLimits(
  files: readonly FileChange[],
  limits: Pick<ReviewLimits, 'maxFiles' | 'exclude'>,
): { files: FileChange[]; skipped: SkippedFile[] } {
  const kept: FileChange[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    if (matchesAnyGlob(file.path, limits.exclude)) {
      skipped.push({ path: file.path, reason: 'Excluded by probatoPR.review.exclude' });
    } else if (kept.length >= limits.maxFiles) {
      skipped.push({ path: file.path, reason: `File limit reached (probatoPR.review.maxFiles = ${limits.maxFiles})` });
    } else {
      kept.push(file);
    }
  }
  return { files: kept, skipped };
}

interface Revisions {
  readonly scope: ReviewScope;
  readonly diffArgs: readonly string[];
  readonly baseRev: string;
  /** undefined = working tree, '' = index, otherwise a commit sha. */
  readonly headRev: string | undefined;
  readonly includeUntracked: boolean;
}

export class LocalChangeCollector {
  constructor(private readonly git: GitClient) {}

  async collect(root: string, request: LocalReviewRequest, limits: ReviewLimits, signal?: AbortSignal): Promise<ChangeSet> {
    const [branch, headSha] = await Promise.all([this.git.currentBranch(root), this.git.resolveCommit(root, 'HEAD')]);
    const revisions = await this.resolveRevisions(root, request, headSha);
    const execOptions = { maxBytes: limits.maxDiffBytes, ...(signal ? { signal } : {}) };

    const diffText = await this.git.diff(root, revisions.diffArgs, execOptions);
    const parsed = parseUnifiedDiff(diffText);
    if (revisions.includeUntracked) {
      for (const untracked of await this.git.untrackedFiles(root)) {
        const content = await this.readWorkingFile(root, untracked, limits.maxFileBytes);
        parsed.push(
          content === undefined
            ? { path: untracked, status: 'added', binary: false, hunks: [], additions: 0, deletions: 0 }
            : untrackedFileChange(untracked, content),
        );
      }
    }
    if (parsed.length === 0) {
      throw new NoChangesError(revisions.scope.label);
    }

    const { files, skipped } = applyLimits(parsed, limits);
    const oldPaths = new Map(files.filter((f) => f.oldPath).map((f) => [f.path, f.oldPath ?? f.path]));

    const content: ContentProvider = {
      read: async (filePath: string, side: ChangeSide) => {
        if (side === 'base') {
          return this.git.readBlob(root, revisions.baseRev, oldPaths.get(filePath) ?? filePath, limits.maxFileBytes);
        }
        if (revisions.headRev === undefined) {
          return this.readWorkingFile(root, filePath, limits.maxFileBytes);
        }
        return this.git.readBlob(root, revisions.headRev, filePath, limits.maxFileBytes);
      },
    };

    return {
      scope: revisions.scope,
      repository: { name: path.basename(root), root, branch, headSha },
      files,
      skipped,
      content,
    };
  }

  private async resolveRevisions(root: string, request: LocalReviewRequest, headSha: string | undefined): Promise<Revisions> {
    const head = headSha ?? EMPTY_TREE_SHA;
    switch (request.kind) {
      case 'working':
        return {
          scope: { kind: 'working', label: tr('current changes (staged + unstaged + untracked)'), baseRef: 'HEAD', headIsWorkingTree: true, ...(headSha ? { baseSha: headSha } : {}) },
          diffArgs: [head],
          baseRev: head,
          headRev: undefined,
          includeUntracked: true,
        };
      case 'staged':
        return {
          scope: { kind: 'staged', label: tr('staged changes'), baseRef: 'HEAD', headRef: 'index', headIsWorkingTree: false, ...(headSha ? { baseSha: headSha } : {}) },
          diffArgs: ['--cached', head],
          baseRev: head,
          headRev: '',
          includeUntracked: false,
        };
      case 'branch': {
        if (!headSha) {
          throw new GitError('The repository has no commits yet.', [], '', null);
        }
        const mergeBase = await this.git.mergeBase(root, request.baseBranch, 'HEAD');
        if (!mergeBase) {
          throw new GitError(`No common ancestor between ${request.baseBranch} and HEAD.`, [], '', null);
        }
        return {
          scope: {
            kind: 'branch',
            label: tr('branch changes since {0}', request.baseBranch),
            baseRef: request.baseBranch,
            baseSha: mergeBase,
            headRef: 'HEAD',
            headSha,
            headIsWorkingTree: false,
          },
          diffArgs: [mergeBase, headSha],
          baseRev: mergeBase,
          headRev: headSha,
          includeUntracked: false,
        };
      }
      case 'commit': {
        const commit = await this.git.resolveCommit(root, request.ref);
        if (!commit) {
          throw new GitError(`Commit "${request.ref}" not found.`, [], '', null);
        }
        const parent = (await this.git.resolveCommit(root, `${commit}^`)) ?? EMPTY_TREE_SHA;
        return {
          scope: {
            kind: 'commit',
            label: tr('commit {0}', commit.slice(0, 10)),
            baseRef: `${commit.slice(0, 10)}^`,
            baseSha: parent,
            headRef: commit.slice(0, 10),
            headSha: commit,
            headIsWorkingTree: false,
          },
          diffArgs: [parent, commit],
          baseRev: parent,
          headRev: commit,
          includeUntracked: false,
        };
      }
    }
  }

  private async readWorkingFile(root: string, relative: string, maxBytes: number): Promise<string | undefined> {
    try {
      const absolute = await resolveInside(root, relative);
      const info = await stat(absolute);
      if (!info.isFile() || info.size > maxBytes) {
        return undefined;
      }
      return await readFile(absolute, 'utf8');
    } catch (error) {
      if (error instanceof PathOutsideWorkspaceError) {
        return undefined; // symlink escaping the repository: never followed
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        return undefined;
      }
      throw error;
    }
  }
}
