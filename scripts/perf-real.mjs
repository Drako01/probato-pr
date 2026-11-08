// End-to-end performance on a real Git repository: runs the built CLI (dist/cli.cjs) on the last N non-merge
// commits, twice each (first and second execution), and reports P50/P95 wall time and peak RSS per change profile.
// Numbers describe the machine that ran them; the report records that environment and claims nothing beyond it.
//
//   pnpm run build
//   node scripts/perf-real.mjs --repo <path> [--commits 20] [--output reports/perf-real.json]

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Change profile thresholds: a "small" change touches at most this many files and lines. */
export const SMALL_CHANGE = { files: 10, lines: 300 };

/** Nearest-rank percentile; `undefined` for an empty sample instead of a fabricated number. */
export function percentile(values, p) {
  if (!values.length) return undefined;
  if (!(p > 0 && p <= 100)) throw new RangeError(`Percentile out of range: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

export function profileOf({ files, lines }) {
  return files <= SMALL_CHANGE.files && lines <= SMALL_CHANGE.lines ? 'small' : 'large';
}

/** Summary per group; failed runs are counted, never mixed into the timings. */
export function summarize(samples) {
  const ok = samples.filter((s) => s.exitCode === 0 || s.exitCode === 1);
  const ms = ok.map((s) => s.wallMs);
  const rss = ok.map((s) => s.peakRssBytes).filter((v) => typeof v === 'number');
  return {
    runs: samples.length,
    failures: samples.length - ok.length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    maxMs: ms.length ? Math.max(...ms) : undefined,
    peakRssBytes: rss.length ? Math.max(...rss) : undefined,
  };
}

function parseArgs(argv) {
  const options = { commits: 20, output: undefined, repo: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === '--repo') options.repo = path.resolve(value);
    else if (key === '--commits') options.commits = Number.parseInt(value, 10);
    else if (key === '--output') options.output = path.resolve(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.repo) throw new Error('--repo <path> is required');
  if (!Number.isInteger(options.commits) || options.commits < 1 || options.commits > 500) throw new Error('--commits must be 1..500');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cli = path.resolve('dist/cli.cjs');
  const probe = path.resolve('scripts/perf-rss-probe.cjs');
  const git = (...args) => execFileSync('git', ['-C', options.repo, ...args], { encoding: 'utf8', maxBuffer: 200_000_000 }).trim();
  const head = git('rev-parse', 'HEAD');
  const commits = git('rev-list', '--no-merges', '-n', String(options.commits), 'HEAD').split('\n').filter(Boolean);
  const scratch = mkdtempSync(path.join(tmpdir(), 'probato-perf-real-'));
  const samples = [];
  try {
    for (const sha of commits) {
      const numstat = git('show', '--numstat', '--format=', sha).split('\n').filter(Boolean);
      const lines = numstat.reduce((sum, row) => sum + row.split('\t').slice(0, 2).reduce((n, v) => n + (Number.parseInt(v, 10) || 0), 0), 0);
      const change = { files: numstat.length, lines };
      for (const execution of ['first', 'second']) {
        const rssFile = path.join(scratch, `${sha}-${execution}.rss`);
        const started = performance.now();
        const result = spawnSync(process.execPath, ['--require', probe, cli, '--root', options.repo, '--scope', 'commit', '--ref', sha, '--format', 'json', '--fail-on', 'none'], { encoding: 'utf8', maxBuffer: 500_000_000, env: { ...process.env, PROBATO_RSS_FILE: rssFile } });
        const wallMs = performance.now() - started;
        let peakRssBytes;
        try { peakRssBytes = Number(readFileSync(rssFile, 'utf8')); } catch { peakRssBytes = undefined; }
        samples.push({ sha, execution, profile: profileOf(change), ...change, wallMs: Math.round(wallMs * 10) / 10, peakRssBytes, exitCode: result.status, ...(result.status === 0 || result.status === 1 ? {} : { error: (result.stderr || String(result.error ?? '')).slice(0, 500) }) });
        process.stderr.write(`${sha.slice(0, 8)} ${execution} ${profileOf(change)} files=${change.files} lines=${change.lines} ${wallMs.toFixed(0)} ms exit=${result.status}\n`);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  const group = (filter) => summarize(samples.filter(filter));
  const report = {
    schema: 'probato-perf-real@1',
    measuredAt: new Date().toISOString(),
    environment: { platform: platform(), osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length, totalMemoryBytes: totalmem(), node: process.version, git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() },
    repository: { name: path.basename(options.repo), head, trackedFiles: git('ls-files').split('\n').filter(Boolean).length, commitsMeasured: commits.length },
    method: 'CLI --scope commit per commit, JSON output, two sequential executions; wall time includes process start; peak RSS is the CLI process (main + worker threads), excluding git children',
    thresholds: SMALL_CHANGE,
    overall: group(() => true),
    byExecution: { first: group((s) => s.execution === 'first'), second: group((s) => s.execution === 'second') },
    byProfile: { small: group((s) => s.profile === 'small'), large: group((s) => s.profile === 'large') },
    samples,
  };
  const text = JSON.stringify(report, null, 2);
  if (options.output) { mkdirSync(path.dirname(options.output), { recursive: true }); writeFileSync(options.output, `${text}\n`); }
  else process.stdout.write(`${text}\n`);
  if (report.overall.failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
