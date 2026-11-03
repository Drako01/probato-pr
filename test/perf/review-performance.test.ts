// Measures end-to-end review time (git diff + analyzers + cross-file scan) on generated repositories of
// increasing size and checks the documented performance budgets. Results are printed, never invented:
// run `pnpm run perf` on the target machine to reproduce.
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDefaultAnalyzers } from '../../src/analyzers';
import { ReviewEngine } from '../../src/core/review-engine';
import { GitClient } from '../../src/git/git-client';
import { LocalChangeCollector } from '../../src/git/local-changes';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { GitWorkspaceIndex } from '../../src/infrastructure/workspace-index';
import { withIncrementalCache } from '../../src/infrastructure/review-cache';
import { initRepo, tempDir, writeFiles } from '../unit/helpers';

interface Profile {
  readonly name: string;
  readonly files: number;
  readonly changed: number;
  readonly budgetMs: number;
}

const PROFILES: readonly Profile[] = [
  { name: 'small', files: 50, changed: 5, budgetMs: 3_000 },
  { name: 'medium', files: 1_000, changed: 50, budgetMs: 15_000 },
  { name: 'large', files: 5_000, changed: 300, budgetMs: 60_000 },
];

const git = new GitClient(new NodeProcessRunner(), { timeoutMs: 120_000, maxBytes: 64_000_000 });
const results: string[] = [];
const cleanups: (() => void)[] = [];

function moduleSource(i: number, renamed: boolean): string {
  const name = renamed ? `renamedFn${i}` : `fn${i}`;
  const dep = i > 0 ? `import { fn${i - 1} } from './m${i - 1}';\n` : '';
  return `${dep}export function ${name}(value: number): number {\n  return value * ${i};\n}\nexport interface Shape${i} { id: string; size: number }\n${i > 0 ? `export const use${i} = fn${i - 1}(1);\n` : ''}`;
}

afterAll(() => {
  cleanups.forEach((c) => {
    c();
  });
  console.log(`[perf]\n${results.join('\n')}`);
});

describe('review performance budgets', () => {
  for (const profile of PROFILES) {
    it(`${profile.name}: ${profile.files} files, ${profile.changed} changed`, async () => {
      const { dir, cleanup } = tempDir(`probato-perf-${profile.name}-`);
      cleanups.push(cleanup);
      const files = Object.fromEntries(Array.from({ length: profile.files }, (_, i) => [`src/m${i}.ts`, moduleSource(i, false)]));
      initRepo(dir, files);
      // Rename exports in evenly spread modules: every rename breaks the next module's import.
      const step = Math.floor(profile.files / profile.changed);
      writeFiles(dir, Object.fromEntries(Array.from({ length: profile.changed }, (_, k) => [`src/m${k * step}.ts`, moduleSource(k * step, true)])));

      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const changes = await new LocalChangeCollector(git).collect(dir, { kind: 'working' }, { maxFiles: 5000, maxDiffBytes: 64_000_000, maxFileBytes: 2_000_000, exclude: [] });
      const review = await new ReviewEngine(createDefaultAnalyzers(), 'perf').review(changes, new GitWorkspaceIndex(git, dir, 2_000_000));
      const elapsed = performance.now() - started;
      const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

      results.push(
        `${profile.name.padEnd(6)} files=${String(profile.files).padStart(5)} changed=${String(profile.changed).padStart(3)} findings=${String(review.findings.length).padStart(3)} time=${elapsed.toFixed(0).padStart(6)} ms (budget ${profile.budgetMs} ms) heapΔ=${heapMb.toFixed(1)} MB`,
      );
      writeFileSync(path.join(dir, '.perf'), String(elapsed));
      expect(review.findings.filter((f) => f.ruleId === 'contracts/export-removed').length).toBe(profile.changed);
      expect(elapsed).toBeLessThan(profile.budgetMs);
    });
  }
});


describe('incremental review measurements', () => {
  it('measures cold and reused analysis without changing findings or hiding source edits', async () => {
    const { dir, cleanup } = tempDir('probato-perf-cache-');
    cleanups.push(cleanup);
    const files = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`src/m${index}.ts`, moduleSource(index, false)]));
    initRepo(dir, files);
    writeFiles(dir, { 'src/m10.ts': moduleSource(10, true) });
    const collect = () => new LocalChangeCollector(git).collect(dir, { kind: 'working' }, { maxFiles: 5000, maxDiffBytes: 64_000_000, maxFileBytes: 2_000_000, exclude: [] });
    const engine = new ReviewEngine(withIncrementalCache(createDefaultAnalyzers(), 'perf-cache'), 'perf-cache');
    const coldStart = performance.now();
    const first = await engine.review(await collect(), new GitWorkspaceIndex(git, dir, 2_000_000));
    const coldMs = performance.now() - coldStart;
    const reusedStart = performance.now();
    const second = await engine.review(await collect(), new GitWorkspaceIndex(git, dir, 2_000_000));
    const reusedMs = performance.now() - reusedStart;
    expect(second.findings).toEqual(first.findings);
    expect(first.findings.some((finding) => finding.ruleId === 'contracts/export-removed')).toBe(true);
    writeFiles(dir, { 'src/m11.ts': moduleSource(11, false).replaceAll('fn10', 'renamedFn10') });
    const changedStart = performance.now();
    const changed = await engine.review(await collect(), new GitWorkspaceIndex(git, dir, 2_000_000));
    const changedMs = performance.now() - changedStart;
    expect(changed.findings.filter((finding) => finding.ruleId === 'contracts/export-removed')).toHaveLength(0);
    const measurement = { files: 500, coldMs, reusedMs, changedMs, firstFindings: first.findings.length, reusedFindings: second.findings.length, changedFindings: changed.findings.length };
    results.push(`incremental ${JSON.stringify(measurement)}`);
    const report = process.env['PROBATO_PERF_REPORT'];
    if (report) writeFileSync(report, JSON.stringify(measurement, null, 2) + '\n');
    // This budget is an upper bound, not an unmeasured promise of a speed-up ratio.
    expect(Math.max(coldMs, reusedMs, changedMs)).toBeLessThan(15_000);
  });
});
