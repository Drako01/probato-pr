import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

export class PathOutsideWorkspaceError extends Error {
  constructor(readonly requested: string, readonly root: string) {
    super(`Path "${requested}" resolves outside of "${root}".`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

/** Converts an OS path to the repository-relative POSIX form used across the domain model. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** True when `candidate` is `root` itself or lies inside it (lexical check on absolute paths). */
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves a repository-relative path and guarantees the result stays inside root, following
 * symlinks for paths that exist. Rejects absolute paths and traversal from untrusted input
 * (diffs, PR file lists, AI responses).
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  if (relative.includes('\0') || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new PathOutsideWorkspaceError(relative, root);
  }
  const realRoot = await realpath(root);
  const candidate = path.resolve(realRoot, relative);
  if (!isWithin(realRoot, candidate)) {
    throw new PathOutsideWorkspaceError(relative, root);
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return candidate; // does not exist yet: lexical check above is the guarantee
    }
    throw error;
  }
  if (!isWithin(realRoot, resolved)) {
    throw new PathOutsideWorkspaceError(relative, root);
  }
  return resolved;
}
