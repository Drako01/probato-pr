import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { isWithin, PathOutsideWorkspaceError, resolveInside } from '../core/paths';
import { isAsarPath } from './safe-text-reader';

/**
 * Electron's regular fs treats .asar filenames as mounts and can throw
 * "Invalid package" for malformed test fixtures. Electron's original-fs
 * exposes the underlying OS file without ASAR interception.
 *
 * The dynamic load keeps the CLI and unit tests working on ordinary Node.
 */
export function rawFileSystem(): typeof fs {
  if (!process.versions.electron) return fs;
  try {
    const nativeRequire = createRequire(path.resolve(process.cwd(), 'probato-raw-fs.cjs'));
    return nativeRequire('original-fs') as typeof fs;
  } catch {
    return fs;
  }
}

/**
 * Preserve the security boundary when resolving an ASAR file through native
 * filesystem APIs. Do not substitute a lexical path for realpath containment.
 */
export async function resolveRawInside(root: string, relative: string): Promise<string> {
  if (!isAsarPath(relative)) return resolveInside(root, relative);
  if (relative.includes('\0') || path.isAbsolute(relative) || path.win32.parse(relative).root !== '') {
    throw new PathOutsideWorkspaceError(relative, root);
  }
  const native = rawFileSystem();
  const realRoot = await native.promises.realpath(root);
  const candidate = path.resolve(realRoot, relative);
  if (!isWithin(realRoot, candidate)) throw new PathOutsideWorkspaceError(relative, root);
  const resolved = await native.promises.realpath(candidate);
  if (!isWithin(realRoot, resolved)) throw new PathOutsideWorkspaceError(relative, root);
  return resolved;
}
