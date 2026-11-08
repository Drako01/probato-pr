import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DependenciesAnalyzer } from '../../src/analyzers/dependencies';
import type { CommandEvidence, ReviewFinding } from '../../src/core/model';
import { finalizeResult, ReviewEngine } from '../../src/core/review-engine';
import { redactSecrets } from '../../src/core/secrets';
import { buildAiContext } from '../../src/ai/ai-context';
import { HistoryStore } from '../../src/infrastructure/history-store';
import { renderJson } from '../../src/reports/json';
import { renderMarkdown, renderPullRequestDescription } from '../../src/reports/markdown';
import { renderSarif } from '../../src/reports/sarif';
import { attribute } from '../../src/verification/attribution';
import { GitClient } from '../../src/git/git-client';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { BaselineWorktree } from '../../src/verification/baseline-worktree';
import { detectChecks } from '../../src/verification/check-detector';
import { applyVerification } from '../../src/verification/evidence-linker';
import { changeSetOf, git, initRepo, tempDir, workspaceOf, writeFiles } from './helpers';

const token = ['sk-proj-', 'A'.repeat(40)].join('');
const pem = `-----BEGIN PRIVATE KEY-----\nSYNTHETIC-BODY-${token}\n-----END PRIVATE KEY-----`;
const diagnostic = { file: 'src/a.ts', line: 1, column: 1, code: 'TS2322', message: 'Incompatible type' };
const commandEvidence = (outcome: 'passed' | 'failed', outputTruncated = false): CommandEvidence => ({
  kind: 'command-run', id: outcome, checkId: 'tsc', revision: 'head', commitSha: undefined, dirty: true,
  commandLine: 'tsc', cwd: '', startedAt: '', durationMs: 1, exitCode: outcome === 'passed' ? 0 : 1,
  signal: null, outcome, outputExcerpt: '', outputTruncated, outputSha256: '',
});
const emptyReview = () => new ReviewEngine([], 'test').review(changeSetOf([{ path: 'src/a.ts', head: 'export const a=1;' }]), workspaceOf({}));

describe('audit: secrets never cross review output boundaries', () => {
  it('redacts complete, overlapping, unterminated and diff-prefixed private key blocks', async () => {
    for (const value of [pem, pem.replace('-----END PRIVATE KEY-----', ''), pem.replaceAll('\n', '\n+ ')]) {
      const result = redactSecrets(value);
      expect(result).not.toContain('SYNTHETIC-BODY');
      expect(result).not.toContain(token);
    }
    const context = await buildAiContext(changeSetOf([{ path: 'src/key.ts', head: `const key = \`${pem}\`;` }]), {
      exclude: [], maxChars: 100_000, includeFileContent: true, knownFindings: [],
    });
    expect(context.prompt.data).not.toContain('SYNTHETIC-BODY');
  });

  it('redacts analyzer descriptions, all report formats and persistence while preserving ids', async () => {
    const changes = changeSetOf([{ path: 'package.json', base: '{}', head: JSON.stringify({ scripts: { postinstall: `echo ${token}` } }) }]);
    const result = await new ReviewEngine([new DependenciesAnalyzer()], 'test').review(changes, workspaceOf({}));
    const untrusted = finalizeResult({ ...result, aiSummary: { author: 'test', overview: token, changes: [], reviewFocus: [pem] } });
    for (const report of [renderJson(untrusted), renderMarkdown(untrusted), renderPullRequestDescription(untrusted), renderSarif(untrusted)]) {
      expect(report).not.toContain(token);
      expect(report).not.toContain('SYNTHETIC-BODY');
    }
    expect(untrusted.findings[0]?.id).toBe(result.findings[0]?.id);
    const temp = tempDir();
    try {
      await new HistoryStore(temp.dir).save(untrusted, undefined);
      expect(readFileSync(path.join(temp.dir, 'reviews.json'), 'utf8')).not.toContain(token);
    } finally { temp.cleanup(); }
  });
});

describe('audit: proof and causal attribution', () => {
  it('does not confirm an unrelated critical AI hypothesis from a compiler error at its location', async () => {
    const review = await emptyReview();
    const ai: ReviewFinding = { id: 'ai', ruleId: 'ai/review', severity: 'critical', verification: 'suspected',
      verificationNote: 'Unproven', origin: 'ai', title: 'Authorization bypass', description: 'Unrelated to types',
      location: { file: 'src/a.ts', startLine: 1 }, evidence: [] };
    const result = applyVerification({ ...review, findings: [ai] }, {
      checks: [{ checkId: 'tsc', kind: 'typecheck', label: 'tsc', commandLine: 'tsc', status: 'failed', headEvidenceId: 'ev', attribution: 'introduced', attributionNote: '' }],
      evidence: [], diagnostics: [{ checkId: 'tsc', head: [diagnostic], introduced: [diagnostic], preExisting: [], hasBaseline: true }],
    });
    expect(result.findings.find((f) => f.id === 'ai')).toMatchObject({ verification: 'suspected' });
    expect(result.findings.find((f) => f.origin === 'verification')).toMatchObject({ verification: 'confirmed', attribution: 'introduced' });
  });

  it('keeps a failed baseline without parsed diagnostics inconclusive', () => {
    expect(attribute(commandEvidence('failed'), commandEvidence('failed'), [diagnostic], []).attribution).toBe('inconclusive');
    expect(attribute(commandEvidence('failed', true), commandEvidence('passed'), [diagnostic], []).attribution).toBe('inconclusive');
  });

  it('detects an additional occurrence of the same diagnostic', () => {
    const additional = { ...diagnostic, line: 20 };
    const result = attribute(commandEvidence('failed'), commandEvidence('failed'), [diagnostic, additional], [diagnostic]);
    expect(result.introducedDiagnostics).toEqual([additional]);
    expect(result.preExistingDiagnostics).toEqual([diagnostic]);
  });
});

describe('audit: execution approval fingerprints', () => {
  const plan = (files: Record<string, string>) => detectChecks({
    readText: (p) => Promise.resolve(files[p]), exists: (p) => Promise.resolve(p in files),
  });
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'node scripts/check.cjs' } }), 'scripts/check.cjs': 'process.exit(0);' };
  it('invalidates approval when lifecycle hooks or a local entrypoint change', async () => {
    const original = (await plan(files))[0];
    const hook = (await plan({ ...files, 'package.json': JSON.stringify({ scripts: { test: 'node scripts/check.cjs', pretest: 'node hook.cjs' } }) }))[0];
    const script = (await plan({ ...files, 'scripts/check.cjs': 'process.exit(1);' }))[0];
    expect(hook?.fingerprint).not.toBe(original?.fingerprint);
    expect(script?.fingerprint).not.toBe(original?.fingerprint);
  });
  it('invalidates approval when build configuration changes without changing the wrapper', async () => {
    const before = (await plan({ 'pom.xml': '<project/>', 'mvnw': '# wrapper' }))[0];
    const after = (await plan({ 'pom.xml': '<project><plugin>new-code</plugin></project>', 'mvnw': '# wrapper' }))[0];
    expect(before?.fingerprint).not.toBe(after?.fingerprint);
  });
});

describe('audit: persistence and SARIF contracts', () => {
  it('recovers after a temporary write failure and can still clear history', async () => {
    const temp = tempDir();
    const directory = path.join(temp.dir, 'storage');
    writeFileSync(directory, 'blocks directory creation');
    const store = new HistoryStore(directory);
    try {
      const review = await emptyReview();
      await expect(store.save(review, undefined)).rejects.toThrow();
      rmSync(directory);
      mkdirSync(directory);
      await expect(store.save(review, undefined)).resolves.toBeUndefined();
      expect((await store.load()).latest?.review.id).toBe(review.id);
      await store.clear();
      expect((await store.load()).history).toEqual([]);
    } finally { temp.cleanup(); }
  });
  it('exports text suggestions without invalid SARIF fix objects', async () => {
    const review = await emptyReview();
    const finding: ReviewFinding = { id: 'f', ruleId: 'test/rule', severity: 'low', verification: 'suspected',
      verificationNote: '', origin: 'ai', title: 'Test', description: '', location: { file: 'src/a.ts', startLine: 1 },
      evidence: [], suggestedFix: 'A textual suggestion' };
    const sarif = JSON.parse(renderSarif({ ...review, findings: [finding] })) as { runs: { results: { fixes?: unknown; properties: { suggestedFix: string } }[] }[] };
    expect(sarif.runs[0]?.results[0]?.fixes).toBeUndefined();
    expect(sarif.runs[0]?.results[0]?.properties.suggestedFix).toBe('A textual suggestion');
  });
});


describe('audit: per-package baseline dependencies', () => {
  const gitClient = new GitClient(new NodeProcessRunner(), { timeoutMs: 30_000, maxBytes: 1_000_000 });
  it('links package node_modules and removes links without deleting dependencies', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { '.gitignore': '**/node_modules/\n', 'packages/a/package.json': '{}' });
      writeFiles(temp.dir, { 'packages/a/node_modules/dep/index.js': 'module.exports = 1;' });
      const baseline = await BaselineWorktree.create(gitClient, temp.dir, git(temp.dir, 'rev-parse', 'HEAD').trim(), ['packages/a']);
      expect(existsSync(path.join(baseline.directory, 'packages/a/node_modules/dep/index.js'))).toBe(true);
      // A baseline of an isolated reviewed checkout must still use the original dependency root.
      const nested = await BaselineWorktree.create(gitClient, baseline.directory, git(temp.dir, 'rev-parse', 'HEAD').trim(), ['packages/a'], temp.dir);
      expect(existsSync(path.join(nested.directory, 'packages/a/node_modules/dep/index.js'))).toBe(true);
      await nested.dispose();
      await baseline.dispose();
      expect(existsSync(path.join(temp.dir, 'packages/a/node_modules/dep/index.js'))).toBe(true);
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    } finally { temp.cleanup(); }
  });
  it('refuses workspace dependency links into head source and cleans the temporary worktree', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { '.gitignore': '**/node_modules/\n', 'packages/a/package.json': '{}' });
      mkdirSync(path.join(temp.dir, 'node_modules'), { recursive: true });
      symlinkSync(path.join(temp.dir, 'packages/a'), path.join(temp.dir, 'node_modules/a'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(BaselineWorktree.create(gitClient, temp.dir, git(temp.dir, 'rev-parse', 'HEAD').trim())).rejects.toThrow(/head source/);
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
      expect(existsSync(path.join(temp.dir, 'packages/a/package.json'))).toBe(true);
    } finally { temp.cleanup(); }
  });
  it('uses canonical dependency roots when temporary directories have aliases', async () => {
    const temp = tempDir();
    const alias = tempDir('probato-root-alias-');
    try {
      initRepo(temp.dir, { '.gitignore': '**/node_modules/\n', 'packages/a/package.json': '{}' });
      mkdirSync(path.join(temp.dir, 'node_modules'), { recursive: true });
      symlinkSync(path.join(temp.dir, 'packages/a'), path.join(temp.dir, 'node_modules/a'), process.platform === 'win32' ? 'junction' : 'dir');
      const rootAlias = path.join(alias.dir, 'repo');
      symlinkSync(temp.dir, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(BaselineWorktree.create(gitClient, temp.dir, git(temp.dir, 'rev-parse', 'HEAD').trim(), [''], rootAlias)).rejects.toThrow(/head source/);
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    } finally { alias.cleanup(); temp.cleanup(); }
  });
  it('fault injection: deletes the directory and prunes the registration when git cannot remove the worktree', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { '.gitignore': '**/node_modules/\n', 'packages/a/package.json': '{}' });
      writeFiles(temp.dir, { 'node_modules/dep/index.js': 'module.exports = 1;' });
      const injected = new Error('injected: worktree remove failed');
      const failing = new (class extends GitClient {
        override removeWorktree(): Promise<void> { return Promise.reject(injected); }
      })(new NodeProcessRunner(), { timeoutMs: 30_000, maxBytes: 1_000_000 });
      const baseline = await BaselineWorktree.create(failing, temp.dir, git(temp.dir, 'rev-parse', 'HEAD').trim());
      await expect(baseline.dispose()).rejects.toBe(injected);
      expect(existsSync(baseline.directory)).toBe(false);
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
      expect(existsSync(path.join(temp.dir, 'node_modules/dep/index.js'))).toBe(true);
    } finally { temp.cleanup(); }
  });
  it('fault injection: still deletes the directory and reports every failure when remove and prune both fail', async () => {
    const temp = tempDir();
    try {
      initRepo(temp.dir, { '.gitignore': '**/node_modules/\n', 'packages/a/package.json': '{}' });
      writeFiles(temp.dir, { 'node_modules/dep/index.js': 'module.exports = 1;' });
      const removeFailure = new Error('injected: worktree remove failed');
      const pruneFailure = new Error('injected: worktree prune failed');
      const failing = new (class extends GitClient {
        override removeWorktree(): Promise<void> { return Promise.reject(removeFailure); }
        override pruneWorktrees(): Promise<void> { return Promise.reject(pruneFailure); }
      })(new NodeProcessRunner(), { timeoutMs: 30_000, maxBytes: 1_000_000 });
      const baseline = await BaselineWorktree.create(failing, temp.dir, git(temp.dir, 'rev-parse', 'HEAD').trim());
      const failure: unknown = await baseline.dispose().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([removeFailure, pruneFailure]);
      expect(existsSync(baseline.directory)).toBe(false);
      expect(existsSync(path.join(temp.dir, 'node_modules/dep/index.js'))).toBe(true);
      git(temp.dir, 'worktree', 'prune');
      expect(git(temp.dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    } finally { temp.cleanup(); }
  });
});
