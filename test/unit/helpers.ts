import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WorkspaceIndex } from '../../src/core/analyzer';
import type { ChangeSet, FileChange } from '../../src/core/model';
import { parseUnifiedDiff } from '../../src/git/diff-parser';

export interface FileSpec {
  readonly path: string;
  readonly base?: string;
  readonly head?: string;
}

/** Real unified diff between two strings, produced by `git diff --no-index` and parsed by the production parser. */
export function diffOf(spec: FileSpec): FileChange {
  const dir = mkdtempSync(path.join(tmpdir(), 'probato-diff-'));
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    writeFileSync(a, spec.base ?? '');
    writeFileSync(b, spec.head ?? '');
    let out = '';
    try {
      out = execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'diff', '--no-index', '--no-color', '--unified=3', 'a', 'b'], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      out = (error as { stdout: string }).stdout; // exit 1 = differences found
    }
    const parsed = parseUnifiedDiff(out)[0];
    const status = spec.base === undefined ? 'added' : spec.head === undefined ? 'deleted' : 'modified';
    return {
      path: spec.path,
      status,
      binary: false,
      hunks: parsed?.hunks ?? [],
      additions: parsed?.additions ?? 0,
      deletions: parsed?.deletions ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function changeSetOf(specs: readonly FileSpec[], extra: Partial<FileChange>[] = []): ChangeSet {
  const files = specs.map((s, i) => ({ ...diffOf(s), ...(extra[i] ?? {}) }));
  const byPath = new Map(specs.map((s) => [s.path, s]));
  return {
    scope: { kind: 'working', label: 'test changes', headIsWorkingTree: true },
    repository: { name: 'fixture', root: '', branch: 'main', headSha: undefined },
    files,
    skipped: [],
    content: {
      read: (p, side) => Promise.resolve(side === 'base' ? byPath.get(p)?.base : byPath.get(p)?.head),
    },
  };
}

/** In-memory workspace with head-side contents of all files (changed or not). */
export function workspaceOf(files: Readonly<Record<string, string>>): WorkspaceIndex {
  return {
    listFiles: (filter) => Promise.resolve(Object.keys(files).filter(filter)),
    read: (p) => Promise.resolve(files[p]),
  };
}

export function tempDir(prefix = 'probato-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

export function initRepo(dir: string, files: Readonly<Record<string, string>>): void {
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
}
