import { open } from 'node:fs/promises';
import { PathOutsideWorkspaceError, resolveInside } from '../core/paths';

/**
 * Electron treats .asar components as archive mounts. A malformed .asar fixture
 * can make even fs.stat() throw "Invalid package". Never touch those paths.
 */
export function isAsarPath(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) => part.toLowerCase().endsWith('.asar'));
}

/**
 * Read only bounded UTF-8 source files. The file descriptor is used for both
 * stat and read, and an extra byte detects files growing during the read.
 * Invalid UTF-8 / NUL bytes are non-text, not source code.
 */
export async function readSafeWorkspaceText(root: string, relative: string, maxBytes: number): Promise<string | undefined> {
  if (isAsarPath(relative)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const absolute = await resolveInside(root, relative);
    handle = await open(absolute, 'r');
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > maxBytes) return undefined;
    const expectedBytes = info.size;
    const buffer = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) return undefined; // changed or truncated while reading
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return undefined;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined; // malformed UTF-8: report as unreviewed, never parse replacement text
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof PathOutsideWorkspaceError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return undefined;
    }
    throw error; // permission/IO errors must not masquerade as a successful read
  } finally {
    await handle?.close();
  }
}
