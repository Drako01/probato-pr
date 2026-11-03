import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/git/git-client';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { ReviewedWorktree } from '../../src/verification/review-worktree';
import { git, initRepo, tempDir, writeFiles } from './helpers';

const client = new GitClient(new NodeProcessRunner(), { timeoutMs: 30_000, maxBytes: 10_000_000 });

describe('isolated reviewed checkout', () => {
  it('materializes exactly the staged text and binary content, preserving unstaged changes and the original index', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { 'value.txt': 'base\n', 'payload.bin': '\0base' });
      const baseSha = git(temp.dir, 'rev-parse', 'HEAD').trim();
      writeFiles(temp.dir, { 'value.txt': 'staged\n', 'new.txt': 'new staged file\n' });
      writeFileSync(path.join(temp.dir, 'payload.bin'), Buffer.from([0, 1, 2, 3]));
      git(temp.dir, 'add', '-A');
      writeFiles(temp.dir, { 'value.txt': 'unstaged\n', 'untracked.txt': 'excluded\n' });
      writeFileSync(path.join(temp.dir, 'payload.bin'), Buffer.from([0, 9, 8, 7]));
      const before = git(temp.dir, 'status', '--porcelain');
      const indexBefore = git(temp.dir, 'write-tree');
      const isolated = await ReviewedWorktree.create(client, temp.dir, { kind: 'staged', label: 'staged', headIsWorkingTree: false, baseSha });
      try {
        expect(readFileSync(path.join(isolated.directory, 'value.txt'), 'utf8').trim()).toBe('staged');
        expect(readFileSync(path.join(isolated.directory, 'new.txt'), 'utf8').trim()).toBe('new staged file');
        expect(readFileSync(path.join(isolated.directory, 'payload.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
        expect(git(isolated.directory, 'ls-files', '--others', '--exclude-standard')).toBe('');
      } finally { await isolated.dispose(); }
      expect(readFileSync(path.join(temp.dir, 'value.txt'), 'utf8')).toBe('unstaged\n');
      expect(git(temp.dir, 'status', '--porcelain')).toBe(before);
      expect(git(temp.dir, 'write-tree')).toBe(indexBefore);
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    } finally { temp.cleanup(); }
  });

  it('materializes a historical commit without changing the current branch', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { 'value.txt': 'historical\n' });
      const headSha = git(temp.dir, 'rev-parse', 'HEAD').trim();
      writeFiles(temp.dir, { 'value.txt': 'current\n' });
      git(temp.dir, 'commit', '-qam', 'newer');
      const currentSha = git(temp.dir, 'rev-parse', 'HEAD');
      const isolated = await ReviewedWorktree.create(client, temp.dir, { kind: 'commit', label: 'historical', headIsWorkingTree: false, headSha });
      try { expect(readFileSync(path.join(isolated.directory, 'value.txt'), 'utf8').trim()).toBe('historical'); }
      finally { await isolated.dispose(); }
      expect(git(temp.dir, 'rev-parse', 'HEAD')).toBe(currentSha);
      expect(readFileSync(path.join(temp.dir, 'value.txt'), 'utf8')).toBe('current\n');
    } finally { temp.cleanup(); }
  });
});
