import * as path from 'node:path';
import { matchesAnyGlob } from '../core/glob';
import { tr } from '../core/i18n';
import type { ChangeSet, ChangeSide, ContentProvider, FileChange, ReviewScope, SkippedFile } from '../core/model';
import { isAsarPath, readSafeWorkspaceText } from '../infrastructure/safe-text-reader';
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
    } else if (isAsarPath(file.path)) {
      skipped.push({ path: file.path, reason: 'ASAR archive is not text source (Electron archive path)' });
    } else if (file.binary) {
      skipped.push({ path: file.path, reason: 'Binary file is not analyzable text' });
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

  async collect(root: string, request: LocalReviewRequest, limits: ReviewLimits, signal?: AbortSignal, allowEmpty = false): Promise<ChangeSet> {
    const [branch, headSha] = await Promise.all([this.git.currentBranch(root), this.git.resolveCommit(root, 'HEAD')]);
    const revisions = await this.resolveRevisions(root, request, headSha);
    const execOptions = { maxBytes: limits.maxDiffBytes, ...(signal ? { signal } : {}) };

    const diffText = await this.git.diff(root, revisions.diffArgs, execOptions);
    const parsed = parseUnifiedDiff(diffText);
    const budgetSkipped: SkippedFile[] = [];
    let eligibleCount = parsed.filter((f) => !matchesAnyGlob(f.path, limits.exclude) && !isAsarPath(f.path) && !f.binary).length;
    let bytes = Buffer.byteLength(diffText);
    if (revisions.includeUntracked) {
      for (const untracked of await this.git.untrackedFiles(root)) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (matchesAnyGlob(untracked, limits.exclude) || eligibleCount >= limits.maxFiles) {
          parsed.push({ path: untracked, status: 'added', binary: false, hunks: [], additions: 0, deletions: 0 });
          continue;
        }
        if (isAsarPath(untracked)) {
          budgetSkipped.push({ path: untracked, reason: 'ASAR archive is not text source (Electron archive path)' });
          continue;
        }
        let content: string | undefined;
        try {
          content = await this.readWorkingFile(root, untracked, limits.maxFileBytes);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') throw error;
          budgetSkipped.push({ path: untracked, reason: 'Untracked file could not be read: ' + code });
          continue;
        }
        if (content === undefined) {
          budgetSkipped.push({ path: untracked, reason: 'Untracked file is missing, oversized, non-text, or outside the workspace' });
          continue;
        }
        bytes += Buffer.byteLength(content);
        if (bytes > limits.maxDiffBytes) {
          budgetSkipped.push({ path: untracked, reason: 'Untracked content exceeds probatoPR.review.maxDiffBytes' });
          continue;
        }
        eligibleCount++;
        parsed.push(untrackedFileChange(untracked, content));
      }
    }
    if (parsed.length === 0 && budgetSkipped.length === 0 && !allowEmpty) {
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
      skipped: [...skipped, ...budgetSkipped],
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

  private readWorkingFile(root: string, relative: string, maxBytes: number): Promise<string | undefined> {
    return readSafeWorkspaceText(root, relative, maxBytes);
  }
}
