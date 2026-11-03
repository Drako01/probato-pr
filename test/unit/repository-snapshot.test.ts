import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '../../src/core/model';
import { GitClient } from '../../src/git/git-client';
import { LocalDelivery } from '../../src/git/local-delivery';
import { repositorySnapshot, assertReviewCurrent } from '../../src/git/repository-snapshot';
import { RevisionWorkspaceIndex } from '../../src/infrastructure/revision-workspace-index';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { git, initRepo, tempDir, writeFiles } from './helpers';

const client = new GitClient(new NodeProcessRunner(), { timeoutMs: 30_000, maxBytes: 5_000_000 });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((c) => { c(); }); });
function repo(): string { const t = tempDir('probato-snapshot-'); cleanups.push(t.cleanup); initRepo(t.dir, { 'a.ts': 'export const a = 1;\n' }); return t.dir; }
function review(root: string, snapshot: string, kind = 'working', sha?: string): ReviewResult {
  return { repository: { root }, snapshot, scope: { kind, headIsWorkingTree: kind === 'working', ...(sha ? { headSha: sha } : {}) } } as ReviewResult;
}

describe('exact repository state', () => {
  it('is stable, and invalidates for untracked content, index changes and branch changes', async () => {
    const root = repo();
    const first = await repositorySnapshot(client, root);
    expect((await repositorySnapshot(client, root)).fingerprint).toBe(first.fingerprint);
    writeFiles(root, { 'new.ts': 'one' });
    const untracked = await repositorySnapshot(client, root);
    expect(untracked.fingerprint).not.toBe(first.fingerprint);
    writeFiles(root, { 'new.ts': 'two' });
    const edited = await repositorySnapshot(client, root);
    expect(edited.fingerprint).not.toBe(untracked.fingerprint);
    git(root, 'add', 'new.ts');
    const staged = await repositorySnapshot(client, root);
    expect(staged.fingerprint).not.toBe(edited.fingerprint);
    git(root, 'switch', '-c', 'other');
    expect((await repositorySnapshot(client, root)).fingerprint).not.toBe(staged.fingerprint);
  });
  it('rejects stale, legacy, historical and index-mismatched verification', async () => {
    const root = repo();
    const first = await repositorySnapshot(client, root);
    await expect(assertReviewCurrent(client, review(root, first.fingerprint))).resolves.toMatchObject({ fingerprint: first.fingerprint });
    await expect(assertReviewCurrent(client, review(root, first.fingerprint, 'commit', 'wrong'))).rejects.toThrow(/reviewed commit/);
    await expect(assertReviewCurrent(client, { ...review(root, first.fingerprint), snapshot: undefined } as unknown as ReviewResult)).rejects.toThrow(/new local review/);
    writeFiles(root, { 'a.ts': 'export const a = 2;\n' });
    await expect(assertReviewCurrent(client, review(root, first.fingerprint))).rejects.toThrow(/changed since/);
    const changed = await repositorySnapshot(client, root);
    await expect(assertReviewCurrent(client, review(root, changed.fingerprint, 'staged'))).rejects.toThrow(/match the index/);
  });
  it('reads cross-file consumers at the reviewed revision or index, never newer working content', async () => {
    const root = repo();
    const head = await client.resolveCommit(root, 'HEAD');
    writeFiles(root, { 'a.ts': 'export const a = 2;\n' });
    git(root, 'add', 'a.ts');
    writeFiles(root, { 'a.ts': 'export const a = 3;\n' });
    expect(await new RevisionWorkspaceIndex(client, root, head ?? 'HEAD', 10000).read('a.ts')).toContain('= 1');
    expect(await new RevisionWorkspaceIndex(client, root, '', 10000).read('a.ts')).toContain('= 2');
  });
});

describe('explicit local Git delivery', () => {
  it('creates and switches branches and commits selected staged files only', async () => {
    const root = repo(); const local = new LocalDelivery(client);
    await local.createBranch(root, 'feature');
    writeFiles(root, { 'b.ts': 'export const b = 2;\n', 'c.ts': 'unselected', 'file[1].ts': 'literal', 'file1.ts': 'must not stage' });
    await local.stage(root, ['file[1].ts']);
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('file[1].ts');
    git(root, 'reset', '-q', 'HEAD', '--', 'file[1].ts');
    await local.stage(root, ['b.ts']);
    // Test identity is repository-local: product itself uses the developer identity without overriding it.
    git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    await local.commit(root, 'feat: selected file');
    expect(git(root, 'show', '--pretty=', '--name-only', 'HEAD').trim()).toBe('b.ts');
    await local.switchBranch(root, 'main');
    expect(await client.currentBranch(root)).toBe('main');
    await expect(local.stage(root, ['.env'])).rejects.toThrow(/Sensitive/);
    await expect(local.stage(root, ['../escape'])).rejects.toThrow();
    await expect(local.synchronize(root)).rejects.toThrow(/stash/);
  });
  it('does not execute a push when detached and rejects an empty commit', async () => {
    const root = repo(); const local = new LocalDelivery(client);
    await expect(local.commit(root, '')).rejects.toThrow(/message/);
    git(root, 'checkout', '--detach');
    await expect(local.push(root)).rejects.toThrow(/branch/);
  });
});


describe('isolated checkout code execution boundary', () => {
  it('never runs configured hooks or smudge filters while materializing review content', async () => {
    const root = repo();
    const hookMarker = path.join(root, 'hook-ran');
    const filterMarker = path.join(root, 'filter-ran');
    const hookCode = `require('fs').writeFileSync(${JSON.stringify(hookMarker)}, 'unexpected');`;
    const filterCode = `require('fs').writeFileSync(${JSON.stringify(filterMarker)}, 'unexpected'); process.stdout.write('filtered');`;
    writeFiles(root, {
      '.gitattributes': '*.data filter=audit\n',
      'a.data': 'original content\n',
      'hook.cjs': hookCode,
      'filter.cjs': filterCode,
      '.probato-pr-hooks-disabled/post-checkout': `#!/bin/sh\nnode "${root.replaceAll('\\', '/')}/hook.cjs"\n`,
    });
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'checkout boundary fixture');
    git(root, 'config', 'core.hooksPath', '.probato-pr-hooks-disabled');
    git(root, 'config', 'filter.audit.smudge', `node "${path.join(root, 'filter.cjs').replaceAll('\\', '/')}"`);
    git(root, 'config', 'filter.audit.required', 'true');
    const target = tempDir('probato-safe-checkout-'); cleanups.push(target.cleanup);
    const directory = path.join(target.dir, 'review');
    try {
      await client.addDetachedWorktree(root, directory, 'HEAD');
      expect(existsSync(hookMarker)).toBe(false);
      expect(existsSync(filterMarker)).toBe(false);
    } finally { await client.removeWorktree(root, directory); }
  });
});


describe('push tracking', () => {
  it('sets the upstream even when pushing an exact commit SHA', async () => {
    const root = repo();
    const remote = tempDir('probato-remote-'); cleanups.push(remote.cleanup);
    git(root, 'init', '--bare', remote.dir);
    git(root, 'remote', 'add', 'origin', remote.dir);
    const local = new LocalDelivery(client);
    await local.push(root);
    expect(git(root, 'config', 'branch.main.remote').trim()).toBe('origin');
    expect(git(root, 'config', 'branch.main.merge').trim()).toBe('refs/heads/main');
    await local.synchronize(root);
  });
});
