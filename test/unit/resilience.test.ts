import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '../../src/core/model';
import { CancelledError, GitClient, GitError, GitNotFoundError, OutputTooLargeError } from '../../src/git/git-client';
import { HistoryStore } from '../../src/infrastructure/history-store';
import type { ProcessRunner, RunResult } from '../../src/infrastructure/process-runner';
import { detectChecks, type ProjectProbe } from '../../src/verification/check-detector';
import { tempDir } from './helpers';

function fakeRunner(partial: Partial<RunResult>): ProcessRunner {
  return {
    run: () =>
      Promise.resolve({
        startedAt: new Date().toISOString(),
        durationMs: 1,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        output: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
        outputSha256: '0'.repeat(64),
        ...partial,
      }),
  };
}

describe('git failure modes', () => {
  const limits = { timeoutMs: 1000, maxBytes: 1000 };
  it('maps a missing git executable to an actionable error', async () => {
    await expect(new GitClient(fakeRunner({ spawnError: 'spawn git ENOENT', exitCode: null }), limits).exec('.', ['status'])).rejects.toBeInstanceOf(GitNotFoundError);
  });
  it('distinguishes cancellation, oversized output and git failures', async () => {
    await expect(new GitClient(fakeRunner({ cancelled: true }), limits).exec('.', ['diff'])).rejects.toBeInstanceOf(CancelledError);
    await expect(new GitClient(fakeRunner({ truncated: true }), limits).exec('.', ['diff'])).rejects.toBeInstanceOf(OutputTooLargeError);
    await expect(new GitClient(fakeRunner({ exitCode: 128, stderr: 'fatal: not a git repository' }), limits).exec('.', ['diff'])).rejects.toThrow(GitError);
  });
  it('rejects refs that could be parsed as options', async () => {
    const client = new GitClient(fakeRunner({}), limits);
    await expect(client.resolveCommit('.', '--output=/tmp/x')).rejects.toThrow(/Unsafe git reference/);
    await expect(client.mergeBase('.', 'main', 'a..b')).rejects.toThrow(/Unsafe git reference/);
  });
});

function probe(files: Record<string, string>): ProjectProbe {
  return {
    readText: (rel) => Promise.resolve(files[rel]),
    exists: (rel) => Promise.resolve(rel in files || Object.keys(files).some((f) => f.startsWith(`${rel}/`))),
  };
}

describe('check planning (case 4: commands that need external infrastructure)', () => {
  it('detects scripts, package manager and infrastructure needs, and never proposes installs', async () => {
    const plan = await detectChecks(
      probe({
        'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'docker compose up -d && vitest run', lint: 'eslint .' } }),
        'pnpm-lock.yaml': '',
        '.env': 'X=1',
      }),
    );
    expect(plan.map((p) => p.label)).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test']);
    const test = plan.find((p) => p.kind === 'test');
    expect(test?.requires).toEqual(['Docker', 'environment variables from .env']);
    expect(test?.warnings.join(' ')).toMatch(/node_modules is missing/);
    expect(plan.every((p) => !p.command.args.includes('install'))).toBe(true);
    expect(plan.find((p) => p.kind === 'typecheck')?.outputFormat).toBe('tsc');
  });

  it('falls back to the local TypeScript compiler and Go tooling', async () => {
    const plan = await detectChecks(probe({ 'package.json': '{}', 'tsconfig.json': '{}', 'node_modules/typescript/bin/tsc': '', 'go.mod': 'module x' }));
    expect(plan.map((p) => p.id)).toEqual(['tsc:noEmit', 'go:build', 'go:vet', 'go:test']);
  });

  it('ignores the npm placeholder test script and unsafe script names', async () => {
    const plan = await detectChecks(probe({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
    expect(plan).toEqual([]);
  });
});

describe('history store', () => {
  const temps: (() => void)[] = [];
  afterEach(() => {
    temps.splice(0).forEach((c) => {
      c();
    });
  });
  const review = { id: 'r1', createdAt: 'now', repository: { name: 'repo' }, scope: { label: 'current' }, risk: { level: 'low' }, findings: [] } as unknown as ReviewResult;

  it('persists, survives a corrupt file and clears', async () => {
    const { dir, cleanup } = tempDir();
    temps.push(cleanup);
    const store = new HistoryStore(dir);
    await store.save(review, undefined);
    expect((await store.load()).history.map((h) => h.id)).toEqual(['r1']);
    writeFileSync(path.join(dir, 'reviews.json'), '{ truncated');
    expect((await store.load()).history).toEqual([]);
    await store.save(review, undefined);
    expect((JSON.parse(readFileSync(path.join(dir, 'reviews.json'), 'utf8')) as { version: number }).version).toBe(2);
    await store.clear();
    expect((await store.load()).latest).toBeUndefined();
  });

  it('works without workspace storage (empty window)', async () => {
    const store = new HistoryStore(undefined);
    await store.save(review, undefined);
    expect((await store.load()).history).toEqual([]);
  });
});
