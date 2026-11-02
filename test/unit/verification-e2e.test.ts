import { existsSync, writeFileSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultAnalyzers } from '../../src/analyzers';
import type { PlannedCheck } from '../../src/core/model';
import { ReviewEngine } from '../../src/core/review-engine';
import { GitClient } from '../../src/git/git-client';
import { LocalChangeCollector, NoChangesError } from '../../src/git/local-changes';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { GitWorkspaceIndex } from '../../src/infrastructure/workspace-index';
import { detectChecks, type ProjectProbe } from '../../src/verification/check-detector';
import { applyVerification } from '../../src/verification/evidence-linker';
import { VerificationEngine } from '../../src/verification/verification-engine';
import { git, initRepo, tempDir, writeFiles } from './helpers';

const runner = new NodeProcessRunner();
const gitClient = new GitClient(runner, { timeoutMs: 30_000, maxBytes: 10_000_000 });
const limits = { maxFiles: 100, maxDiffBytes: 5_000_000, maxFileBytes: 1_000_000, exclude: [] };
const engine = new VerificationEngine(runner, gitClient);
const TSC = path.resolve('node_modules/typescript/bin/tsc');

function probeOf(root: string): ProjectProbe {
  return {
    readText: (rel) => readFile(path.join(root, rel), 'utf8').catch(() => undefined),
    exists: (rel) => access(path.join(root, rel)).then(() => true, () => false),
  };
}

function tscCheck(files: string[]): PlannedCheck {
  return {
    id: 'tsc:test',
    kind: 'typecheck',
    label: 'tsc --noEmit',
    command: { executable: process.execPath, args: [TSC, '--noEmit', '--pretty', 'false', '--strict', ...files] },
    cwd: '',
    rationale: 'test',
    warnings: [],
    requires: [],
    outputFormat: 'tsc',
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => {
    c();
  });
});

function repo(files: Record<string, string>): string {
  const { dir, cleanup } = tempDir('probato-e2e-');
  cleanups.push(cleanup);
  initRepo(dir, files);
  return dir;
}

describe('end-to-end: review + verification with baseline attribution', () => {
  it('confirms a static contract finding when the type-check fails only after the change', async () => {
    const root = repo({
      'src/a.ts': 'export function foo(): number { return 1; }\n',
      'src/b.ts': "import { foo } from './a';\nexport const value: number = foo();\n",
    });
    writeFiles(root, { 'src/a.ts': 'export function bar(): number { return 1; }\n' });

    const changes = await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits);
    expect(changes.files.map((f) => f.path)).toEqual(['src/a.ts']);
    const review = await new ReviewEngine(createDefaultAnalyzers(), 'test').review(changes, new GitWorkspaceIndex(gitClient, root, 1_000_000));
    const staticFinding = review.findings.find((f) => f.ruleId === 'contracts/export-removed');
    expect(staticFinding).toMatchObject({ verification: 'evidenced', location: { file: 'src/b.ts', startLine: 1 } });

    const headSha = git(root, 'rev-parse', 'HEAD').trim();
    const outcome = await engine.run({
      repoRoot: root,
      approved: [tscCheck(['src/a.ts', 'src/b.ts'])],
      baselineCommit: headSha,
      headSha,
      headDirty: true,
      timeoutMs: 120_000,
      maxOutputBytes: 500_000,
    });
    expect(outcome.checks[0]).toMatchObject({ status: 'failed', attribution: 'introduced' });
    expect(outcome.evidence.map((e) => [e.revision, e.outcome])).toEqual([
      ['head', 'failed'],
      ['base', 'passed'],
    ]);

    const verified = applyVerification(review, outcome);
    const confirmed = verified.findings.find((f) => f.id === staticFinding?.id);
    expect(confirmed).toMatchObject({ verification: 'confirmed', attribution: 'introduced' });
    expect(confirmed?.evidence.length).toBe(2);
    expect(verified.risk.level).toBe('high');
    // The temporary worktree is gone.
    expect(git(root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 180_000);

  it('does not attribute a failure that already exists on the base revision (case 1)', async () => {
    const root = repo({
      'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node check.js' } }),
      'check.js': "const t = require('fs').readFileSync('value.txt', 'utf8'); process.exit(t.includes('BROKEN') ? 1 : 0);\n",
      'value.txt': 'BROKEN\n',
      'other.txt': 'a\n',
    });
    writeFiles(root, { 'other.txt': 'b\n' });
    const plan = await detectChecks(probeOf(root));
    expect(plan.map((p) => p.id)).toEqual(['script:test']);
    const headSha = git(root, 'rev-parse', 'HEAD').trim();
    const outcome = await engine.run({ repoRoot: root, approved: plan, baselineCommit: headSha, headSha, headDirty: true, timeoutMs: 120_000, maxOutputBytes: 100_000 });
    expect(outcome.checks[0]).toMatchObject({ status: 'failed', attribution: 'pre-existing' });
  }, 180_000);

  it('attributes a test failure introduced by the change (case 2)', async () => {
    const root = repo({
      'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node check.js' } }),
      'check.js': "const t = require('fs').readFileSync('value.txt', 'utf8'); process.exit(t.includes('BROKEN') ? 1 : 0);\n",
      'value.txt': 'ok\n',
    });
    writeFiles(root, { 'value.txt': 'BROKEN\n' });
    const headSha = git(root, 'rev-parse', 'HEAD').trim();
    const plan = await detectChecks(probeOf(root));
    const outcome = await engine.run({ repoRoot: root, approved: plan, baselineCommit: headSha, headSha, headDirty: true, timeoutMs: 120_000, maxOutputBytes: 100_000 });
    expect(outcome.checks[0]).toMatchObject({ status: 'failed', attribution: 'introduced' });
  }, 180_000);

  it('reports a missing tool as an error, never as pass or fail (case 3)', async () => {
    const root = repo({ 'a.txt': 'x\n' });
    const check: PlannedCheck = { ...tscCheck([]), id: 'missing', command: { executable: 'probato-missing-linter', args: ['.'] } };
    const outcome = await engine.run({ repoRoot: root, approved: [check], baselineCommit: undefined, headSha: undefined, headDirty: false, timeoutMs: 10_000, maxOutputBytes: 10_000 });
    expect(outcome.checks[0]?.status).toBe('error');
    expect(outcome.checks[0]?.attributionNote).toMatch(/not installed or not on PATH/);
  });

  it('marks failures without a baseline as inconclusive', async () => {
    const root = repo({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(1)"' } }) });
    const plan = await detectChecks(probeOf(root));
    const outcome = await engine.run({ repoRoot: root, approved: plan, baselineCommit: undefined, headSha: undefined, headDirty: false, timeoutMs: 60_000, maxOutputBytes: 10_000 });
    expect(outcome.checks[0]).toMatchObject({ status: 'failed', attribution: 'inconclusive' });
  }, 120_000);

  it('never deletes the real node_modules when cleaning the baseline worktree', async () => {
    const root = repo({
      '.gitignore': 'node_modules/\n',
      'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'node_modules/dep/index.js\') ? 1 : 0)"' } }),
    });
    writeFiles(root, { 'node_modules/dep/index.js': 'module.exports = 1;\n', 'new.txt': 'x\n' });
    const headSha = git(root, 'rev-parse', 'HEAD').trim();
    const plan = await detectChecks(probeOf(root));
    // Head fails (dep exists) → baseline runs in a worktree whose node_modules links to the real one.
    const outcome = await engine.run({ repoRoot: root, approved: plan, baselineCommit: headSha, headSha, headDirty: true, timeoutMs: 120_000, maxOutputBytes: 10_000 });
    expect(outcome.evidence.map((e) => e.revision)).toEqual(['head', 'base']);
    expect(outcome.baselineError).toBeUndefined();
    expect((await stat(path.join(root, 'node_modules/dep/index.js'))).isFile()).toBe(true);
  }, 180_000);
});

describe('local change collection', () => {
  it('throws NoChangesError for a clean repository', async () => {
    const root = repo({ 'a.txt': 'x\n' });
    await expect(new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits)).rejects.toBeInstanceOf(NoChangesError);
  });

  it('collects staged vs unstaged changes separately, including unicode and spaced paths', async () => {
    const root = repo({ 'dir with space/café.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    writeFiles(root, { 'dir with space/café.ts': 'export const a = 2;\n', 'b.ts': 'export const b = 2;\n', 'untracked.ts': 'x\n' });
    git(root, 'add', 'dir with space/café.ts');
    const collector = new LocalChangeCollector(gitClient);
    const staged = await collector.collect(root, { kind: 'staged' }, limits);
    expect(staged.files.map((f) => f.path)).toEqual(['dir with space/café.ts']);
    expect(await staged.content.read('dir with space/café.ts', 'head')).toBe('export const a = 2;\n');
    expect(await staged.content.read('dir with space/café.ts', 'base')).toBe('export const a = 1;\n');
    const working = await collector.collect(root, { kind: 'working' }, limits);
    expect(working.files.map((f) => f.path).sort()).toEqual(['b.ts', 'dir with space/café.ts', 'untracked.ts']);
  });

  it('reviews a branch against its merge base and a single commit', async () => {
    const root = repo({ 'a.ts': 'export const a = 1;\n' });
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFiles(root, { 'a.ts': 'export const a = 2;\n' });
    git(root, 'commit', '-qam', 'change');
    const collector = new LocalChangeCollector(gitClient);
    const branch = await collector.collect(root, { kind: 'branch', baseBranch: 'main' }, limits);
    expect(branch.scope.kind).toBe('branch');
    expect(branch.files.map((f) => f.path)).toEqual(['a.ts']);
    const commit = await collector.collect(root, { kind: 'commit', ref: 'HEAD' }, limits);
    expect(commit.files[0]?.additions).toBe(1);
    expect(await gitClient.defaultBaseBranch(root, '')).toBe('main');
  });

  it('applies exclusions and file limits, reporting what was skipped', async () => {
    const root = repo({ 'a.ts': '1\n', 'b.ts': '1\n', 'dist/c.js': '1\n' });
    writeFiles(root, { 'a.ts': '2\n', 'b.ts': '2\n', 'dist/c.js': '2\n' });
    const result = await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, { ...limits, maxFiles: 1, exclude: ['dist/**'] });
    expect(result.files).toHaveLength(1);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['b.ts', 'dist/c.js']);
  });

  it('does not execute a malicious fsmonitor hook from repository config', async () => {
    const root = repo({ 'a.txt': 'x\n' });
    const marker = path.join(root, 'pwned.txt');
    const hook = path.join(root, 'hook.js');
    writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    git(root, 'config', 'core.fsmonitor', `node ${hook.replace(/\\/g, '/')}`);
    writeFiles(root, { 'a.txt': 'y\n' });
    await new LocalChangeCollector(gitClient).collect(root, { kind: 'working' }, limits);
    await gitClient.isDirty(root);
    expect(existsSync(marker)).toBe(false);
  });
});
