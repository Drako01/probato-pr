import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalChangeCollector, applyLimits } from '../../src/git/local-changes';
import { repositorySnapshot } from '../../src/git/repository-snapshot';
import { resolveRawInside } from '../../src/infrastructure/raw-fs';
import { GitClient } from '../../src/git/git-client';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { GitWorkspaceIndex } from '../../src/infrastructure/workspace-index';
import { RevisionWorkspaceIndex } from '../../src/infrastructure/revision-workspace-index';
import { isAsarPath, readSafeWorkspaceText } from '../../src/infrastructure/safe-text-reader';
import { git, initRepo, tempDir, writeFiles } from './helpers';

const gitClient = new GitClient(new NodeProcessRunner(), { timeoutMs: 30000, maxBytes: 5000000 });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((c) => { c(); }); });
function repo(): string {
  const t = tempDir('probato-asar-');
  cleanups.push(t.cleanup);
  initRepo(t.dir, { 'src/ok.ts': 'export const x = 1;\n', 'fixtures/invalid.asar': 'not a real ASAR archive' });
  return t.dir;
}
const limits = { maxFiles: 300, maxDiffBytes: 4000000, maxFileBytes: 2000000, exclude: [] };

describe('safe source reads (Electron ASAR + hostile or unstable files)', () => {
  it('recognizes .asar components on POSIX and Windows without matching ordinary names', () => {
    expect(isAsarPath('fixtures/foo.asar')).toBe(true);
    expect(isAsarPath('F:\\repo\\fixtures\\BAD.ASAR\\dir\\index.ts')).toBe(true);
    expect(isAsarPath('archive.asar.unpacked/index.ts')).toBe(false);
    expect(isAsarPath('component.asar.ts')).toBe(false);
  });

  it('never opens malformed .asar fixtures and leaves ordinary UTF-8 readable', async () => {
    const root = repo();
    expect(await readSafeWorkspaceText(root, 'fixtures/invalid.asar', 100)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, 'src/ok.ts', 100)).toBe('export const x = 1;\n');
    expect(await readSafeWorkspaceText(root, 'fixtures/invalid.asar/nested.ts', 100)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, 'missing.ts', 100)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, '../escape.ts', 100)).toBeUndefined();
  });

  it('bounds reads and rejects NUL bytes, invalid UTF-8, directories and modified files', async () => {
    const root = repo();
    mkdirSync(path.join(root, 'samples'), { recursive: true });
    writeFileSync(path.join(root, 'samples', 'binary.bin'), Buffer.from([65, 0, 66]));
    writeFileSync(path.join(root, 'samples', 'invalid.ts'), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(path.join(root, 'samples', 'large.ts'), 'text longer than the cap');
    expect(await readSafeWorkspaceText(root, 'samples/binary.bin', 100)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, 'samples/invalid.ts', 100)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, 'samples/large.ts', 4)).toBeUndefined();
    expect(await readSafeWorkspaceText(root, 'samples', 100)).toBeUndefined();
  });

  it('fingerprints tracked and untracked ASAR bytes without interpreting an archive', async () => {
    const root = repo();
    const original = await repositorySnapshot(gitClient, root);
    const actual = await resolveRawInside(root, 'fixtures/invalid.asar');
    expect(actual).toContain('invalid.asar');
    writeFiles(root, { 'fixtures/invalid.asar': 'modified malformed archive' });
    const changed = await repositorySnapshot(gitClient, root);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    writeFiles(root, { 'new.asar': 'first' });
    const untracked = await repositorySnapshot(gitClient, root);
    writeFiles(root, { 'new.asar': 'second' });
    expect((await repositorySnapshot(gitClient, root)).fingerprint).not.toBe(untracked.fingerprint);
  });

  it('reports ASAR and binary changes as skipped, without hiding valid source changes', async () => {
    const root = repo();
    writeFiles(root, { 'src/ok.ts': 'export const x = 2;\n', 'fixtures/invalid.asar': 'still not an archive' });
    const changes = await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits);
    expect(changes.files.map((f) => f.path)).toContain('src/ok.ts');
    expect(changes.skipped.some((file) => file.path === 'fixtures/invalid.asar' && file.reason.includes('ASAR'))).toBe(true);
    const binary = applyLimits([{ path: 'image.png', status: 'modified', binary: true, hunks: [], additions: 0, deletions: 0 }], limits);
    expect(binary.files).toHaveLength(0);
    expect(binary.skipped[0]?.reason).toContain('Binary');
  });

  it('skips ASAR and other untracked non-text data without a fatal error', async () => {
    const root = repo();
    writeFiles(root, { 'new.asar': 'malformed archive fixture', 'new.ts': 'export const y = 1;\n' });
    writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2]));
    const changes = await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits);
    expect(changes.files.map((f) => f.path)).toContain('new.ts');
    expect(changes.skipped.map((f) => f.path)).toEqual(expect.arrayContaining(['new.asar', 'blob.bin']));
    expect(await changes.content.read('new.asar', 'head')).toBeUndefined();
  });

  it('keeps a skip-only review possible (risk remains unverified)', async () => {
    const root = repo();
    writeFiles(root, { 'only.asar': 'invalid archive' });
    const changes = await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits);
    expect(changes.files).toHaveLength(0);
    expect(changes.skipped.map((f) => f.path)).toContain('only.asar');
  });

  it('does not expose .asar paths from either workspace index', async () => {
    const root = repo();
    const working = new GitWorkspaceIndex(gitClient, root, 2000000);
    expect(await working.listFiles(() => true)).not.toContain('fixtures/invalid.asar');
    expect(await working.read('fixtures/invalid.asar')).toBeUndefined();
    const revision = new RevisionWorkspaceIndex(gitClient, root, 'HEAD', 2000000);
    expect(await revision.listFiles(() => true)).not.toContain('fixtures/invalid.asar');
    expect(await revision.read('fixtures/invalid.asar')).toBeUndefined();
    expect(await revision.read('src/ok.ts')).toContain('x = 1');
  });

  it('reports an intentionally unreadable tracked file as a failed read rather than pretending success', async () => {
    const root = repo();
    // A process denied access/locked file is an I/O failure; never convert arbitrary failures to a passing result.
    const workspace = new GitWorkspaceIndex(gitClient, root, 2000000);
    expect(await workspace.read('src/ok.ts')).toContain('x = 1');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
