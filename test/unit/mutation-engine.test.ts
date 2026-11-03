import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MutationEngine, mutationCommandEvidence } from '../../src/mutation/engine';
import { GitClient } from '../../src/git/git-client';
import { NodeProcessRunner, type ProcessRunner, type RunResult } from '../../src/infrastructure/process-runner';
import type { MutationResult } from '../../src/mutation/model';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!root.startsWith(path.join(tmpdir(), 'probato-mut-unit-'))) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture(tool = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'probato-mut-unit-')); roots.push(root);
  const git = new GitClient(new NodeProcessRunner(), { timeoutMs: 10_000, maxBytes: 1_000_000 });
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/a.ts'), 'export const x = true;\n');
  await writeFile(path.join(root, 'test/a.test.ts'), 'const baselineTest = true;\n');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  await writeFile(path.join(root, 'stryker.config.json'), JSON.stringify({ testRunner: 'command', thresholds: { high: 90, low: 75, break: 75 } }));
  if (tool) {
    await mkdir(path.join(root, 'node_modules/@stryker-mutator/core/bin'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/@stryker-mutator/core/package.json'), JSON.stringify({ name: '@stryker-mutator/core', version: '10.1.1', bin: { stryker: 'bin/stryker.js' } }));
    await writeFile(path.join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'), '// fixture runner never executes');
  }
  await git.exec(root, ['init', '-q', '-b', 'main']); await git.exec(root, ['add', '.']);
  await git.execWithoutCheckoutCode(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  return { root, git };
}
function outcome(overrides: Partial<RunResult> = {}): RunResult { return { startedAt: new Date().toISOString(), durationMs: 1, exitCode: 0, signal: null, stdout: '', stderr: '', output: '', truncated: false, timedOut: false, cancelled: false, outputSha256: 'a'.repeat(64), ...overrides }; }
function report(source: string, status = 'Killed') { return { schemaVersion: '3', files: { 'src/a.ts': { source, mutants: [{ id: '1', status, mutatorName: 'Boolean', replacement: 'false', location: { start: { line: 1, column: 18 }, end: { line: 1, column: 22 } } }] } } }; }
function terminal(updates: readonly MutationResult[]) {
  const final = updates.filter((result) => result.execution.status === 'COMPLETED' || result.execution.status === 'CANCELLED');
  expect(final).toHaveLength(1);
  expect(final[0]?.finishedAt).toBe(final[0]?.execution.events.at(-1)?.at);
  return final[0];
}

describe('mutation engine execution boundaries', () => {
  it('does not execute without authorization and skips a missing local Stryker without fake evidence', async () => {
    const { root, git } = await fixture(false); const run = vi.fn<ProcessRunner['run']>();
    const engine = new MutationEngine({ run }, git);
    expect((await engine.run({ root, impactedFiles: ['src/a.ts'], authorized: false })).execution.status).toBe('AWAITING_APPROVAL');
    const updates: MutationResult[] = [];
    const result = await engine.run({ root, impactedFiles: ['src/a.ts'], authorized: true, onUpdate: (value) => { updates.push(value); } });
    expect(result.verification.status).toBe('SKIP'); expect(result.head).toBeUndefined(); expect(run).not.toHaveBeenCalled();
    expect(mutationCommandEvidence(result)).toEqual([]); terminal(updates);
  });
  it.each(['timeout', 'cancel', 'error'] as const)('records %s independently and emits a complete terminal result once', async (kind) => {
    const { root, git } = await fixture(); const updates: MutationResult[] = [];
    const run = vi.fn<ProcessRunner['run']>().mockResolvedValue(outcome(kind === 'timeout' ? { timedOut: true, exitCode: null } : kind === 'cancel' ? { cancelled: true, exitCode: null, signal: 'SIGTERM' } : { exitCode: 2, stderr: 'tool failed', output: 'tool failed' }));
    const result = await new MutationEngine({ run }, git).run({ root, impactedFiles: ['src/a.ts'], authorized: true, gatePolicy: { enabled: true }, onUpdate: (value) => { updates.push(value); } });
    expect(result.execution.status).toBe(kind === 'cancel' ? 'CANCELLED' : 'COMPLETED');
    expect(result.verification.status).toBe(kind === 'error' ? 'ERROR' : 'INCONCLUSIVE');
    expect(result.gate.decision).toBe('INCONCLUSIVE'); expect(result.quality.deltaPoints).toBeUndefined();
    expect(mutationCommandEvidence(result)).toHaveLength(1); expect(terminal(updates)).toEqual(result);
  });
  it('retains caller-configured Stryker thresholds and interprets a valid threshold exit as FAIL, not infrastructure ERROR', async () => {
    const { root, git } = await fixture();
    const run = vi.fn<ProcessRunner['run']>().mockImplementation(async (_command, options) => {
      const config = JSON.parse(await readFile(path.join(options.cwd, '.probato-stryker.config.json'), 'utf8')) as { thresholds: unknown };
      expect(config.thresholds).toEqual({ high: 90, low: 75, break: 75 });
      await writeFile(path.join(options.cwd, 'probato-mutation-report.json'), JSON.stringify(report(await readFile(path.join(options.cwd, 'src/a.ts'), 'utf8'), 'Survived')));
      return outcome({ exitCode: 1 });
    });
    const result = await new MutationEngine({ run }, git).run({ root, impactedFiles: ['src/a.ts'], authorized: true, gatePolicy: { enabled: true } });
    expect(result.head?.thresholdFailure).toBe(true); expect(result.head?.absoluteThreshold).toBe(75);
    expect(result.verification.status).toBe('FAIL'); expect(result.gate.decision).toBe('FAIL');
    expect(mutationCommandEvidence(result)[0]?.outcome).toBe('failed');
  });
  it('keeps real process evidence when structured output is malformed', async () => {
    const { root, git } = await fixture();
    const run = vi.fn<ProcessRunner['run']>().mockImplementation(async (_command, options) => { await writeFile(path.join(options.cwd, 'probato-mutation-report.json'), '{invalid'); return outcome({ truncated: true, output: 'trace' }); });
    const result = await new MutationEngine({ run }, git).run({ root, impactedFiles: ['src/a.ts'], authorized: true });
    expect(result.verification.status).toBe('ERROR'); expect(result.head?.report).toBeUndefined();
    expect(mutationCommandEvidence(result)[0]).toMatchObject({ outputTruncated: true, outputExcerpt: 'trace' });
  });
  it('rejects oversized structured reports within the configured resource limit', async () => {
    const { root, git } = await fixture();
    const run = vi.fn<ProcessRunner['run']>().mockImplementation(async (_command, options) => { await writeFile(path.join(options.cwd, 'probato-mutation-report.json'), 'x'.repeat(2001)); return outcome(); });
    const result = await new MutationEngine({ run }, git).run({ root, impactedFiles: ['src/a.ts'], authorized: true, limits: { maxReportBytes: 1000 } });
    expect(result.verification.status).toBe('ERROR');
    expect(result.verification.reasons.join(' ')).toContain('safe read limit');
    expect(result.head?.id).toMatch(/^mutation-head-/);
    expect(mutationCommandEvidence(result)).toHaveLength(1);
    expect(result.gate.decision).toBe('SKIP');
  });
  it('does not substitute current Stryker settings when the baseline has no configuration', async () => {
    const { root, git } = await fixture();
    await git.exec(root, ['rm', 'stryker.config.json']);
    await git.execWithoutCheckoutCode(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base without Stryker config']);
    const baseCommit = await git.resolveCommit(root, 'HEAD');
    if (!baseCommit) throw new Error('Missing fixture base');
    await writeFile(path.join(root, 'stryker.config.json'), JSON.stringify({ testRunner: 'command' }));
    const run = vi.fn<ProcessRunner['run']>().mockImplementation(async (_command, options) => { await writeFile(path.join(options.cwd, 'probato-mutation-report.json'), JSON.stringify(report(await readFile(path.join(options.cwd, 'src/a.ts'), 'utf8')))); return outcome(); });
    const result = await new MutationEngine({ run }, git).run({ root, baseCommit, impactedFiles: ['src/a.ts'], authorized: true, gatePolicy: { enabled: true } });
    expect(run).toHaveBeenCalledOnce(); expect(result.head?.report).toBeDefined();
    expect(result.verification.status).toBe('INCONCLUSIVE'); expect(result.gate.decision).toBe('INCONCLUSIVE'); expect(result.quality.deltaPoints).toBeUndefined();
    expect(result.verification.reasons.join(' ')).toContain('not substituted');
  });
  it('honors staged deletions and includes untracked tests in the actual mutation snapshot', async () => {
    const { root, git } = await fixture(); await git.exec(root, ['rm', 'test/a.test.ts']);
    await mkdir(path.join(root, 'test'), { recursive: true });
    await writeFile(path.join(root, 'test/new.test.ts'), 'const newTest = true;\n');
    const run = vi.fn<ProcessRunner['run']>().mockImplementation(async (_command, options) => {
      await expect(access(path.join(options.cwd, 'test/a.test.ts'))).rejects.toThrow();
      expect(await readFile(path.join(options.cwd, 'test/new.test.ts'), 'utf8')).toContain('newTest');
      await writeFile(path.join(options.cwd, 'probato-mutation-report.json'), JSON.stringify(report(await readFile(path.join(options.cwd, 'src/a.ts'), 'utf8'))));
      return outcome();
    });
    const result = await new MutationEngine({ run }, git).run({ root, impactedFiles: ['src/a.ts'], authorized: true });
    expect(run).toHaveBeenCalledOnce(); expect(result.head?.reproducibility?.testHash).toMatch(/^[a-f0-9]{64}$/); expect(result.verification.status).toBe('PASS');
  });
});
