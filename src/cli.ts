import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import manifest from '../package.json';
import { createDefaultAnalyzers } from './analyzers';
import { SEVERITIES, type ReviewResult, type Severity } from './core/model';
import { ReviewEngine } from './core/review-engine';
import { redactSecrets } from './core/secrets';
import { GitClient } from './git/git-client';
import { LocalChangeCollector, type LocalReviewRequest } from './git/local-changes';
import { assertReviewCurrent, repositorySnapshot } from './git/repository-snapshot';
import { NodeProcessRunner } from './infrastructure/process-runner';
import { GitWorkspaceIndex } from './infrastructure/workspace-index';
import { RevisionWorkspaceIndex } from './infrastructure/revision-workspace-index';
import { ReviewedWorktree } from './verification/review-worktree';
import { renderJson } from './reports/json';
import { renderMarkdown } from './reports/markdown';
import { renderSarif } from './reports/sarif';
import { importSarif } from './reports/sarif-import';
import { applyVerification } from './verification/evidence-linker';
import { detectMonorepoChecks } from './verification/monorepo-checks';
import { VerificationEngine } from './verification/verification-engine';

export interface CliOptions {
  readonly root: string;
  readonly scope: LocalReviewRequest;
  readonly format: 'json' | 'markdown' | 'sarif';
  readonly output?: string;
  readonly failOn: Severity | 'none';
  readonly verify: readonly string[];
  readonly baseline: boolean;
  readonly listChecks: boolean;
  readonly importFile?: string;
  readonly help: boolean;
}

export const CLI_HELP = `Probato PR â€” local, evidence-based review
Usage: probato-pr [--root DIR] [--scope working|staged|branch|commit]
  --base REF                     Base branch for branch review
  --ref REF                      Commit for commit review (default HEAD)
  --format json|markdown|sarif    Report format (default markdown)
  --output FILE                  Write the report instead of stdout
  --fail-on critical|high|medium|low|none   Finding threshold (default high)
  --list-checks                  List detected check IDs without executing them
  --verify ID,ID | all           Explicitly authorize these project checks
  --baseline                     Explicitly authorize repeating failed checks on base
  --import-sarif FILE            Merge external diagnostics as unconfirmed evidence
  --help                        Show this help
Exit codes: 0 threshold not reached; 1 findings meet threshold; 2 execution/configuration error.
Checks execute repository code with your permissions. Nothing is installed automatically.
`;

export function parseCliArgs(args: readonly string[], cwd = process.cwd()): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleans = new Set(['--baseline', '--list-checks', '--help']);
  const named = new Set(['--root', '--scope', '--base', '--ref', '--format', '--output', '--fail-on', '--verify', '--import-sarif']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) { continue; }
    if (booleans.has(arg)) { flags.add(arg); continue; }
    if (!named.has(arg)) { throw new Error(`Unknown option: ${arg}`); }
    const value = args[++index];
    if (!value || value.startsWith('--')) { throw new Error(`Missing value for ${arg}`); }
    if (values.has(arg)) { throw new Error(`Duplicate option: ${arg}`); }
    values.set(arg, value);
  }
  const kind = values.get('--scope') ?? 'working';
  let scope: LocalReviewRequest;
  if (kind === 'working' || kind === 'staged') { scope = { kind }; }
  else if (kind === 'branch') {
    const baseBranch = values.get('--base');
    if (!baseBranch) { throw new Error('--scope branch requires --base REF.'); }
    scope = { kind, baseBranch };
  } else if (kind === 'commit') { scope = { kind, ref: values.get('--ref') ?? 'HEAD' }; }
  else { throw new Error(`Unknown scope: ${kind}`); }
  if (values.has('--base') && kind !== 'branch') { throw new Error('--base applies only to branch scope.'); }
  if (values.has('--ref') && kind !== 'commit') { throw new Error('--ref applies only to commit scope.'); }
  const format = values.get('--format') ?? 'markdown';
  if (format !== 'json' && format !== 'markdown' && format !== 'sarif') { throw new Error(`Unknown format: ${format}`); }
  const failOn = values.get('--fail-on') ?? 'high';
  if (failOn !== 'none' && !SEVERITIES.includes(failOn as Severity)) { throw new Error(`Unknown severity: ${failOn}`); }
  const output = values.get('--output'), importFile = values.get('--import-sarif');
  return {
    root: path.resolve(cwd, values.get('--root') ?? '.'), scope, format, failOn: failOn as Severity | 'none',
    verify: (values.get('--verify') ?? '').split(',').filter(Boolean), baseline: flags.has('--baseline'), listChecks: flags.has('--list-checks'), help: flags.has('--help'),
    ...(output ? { output: path.resolve(cwd, output) } : {}), ...(importFile ? { importFile: path.resolve(cwd, importFile) } : {}),
  };
}

export function reportExitCode(review: ReviewResult, threshold: Severity | 'none'): number {
  if (review.analyzerRuns.some((run) => run.status === 'failed') || review.checks.some((check) => check.status === 'error' || check.status === 'timed-out' || check.status === 'cancelled' || check.status === 'pending')) { return 2; }
  if (review.checks.some((check) => check.status === 'failed')) { return 1; }
  return threshold !== 'none' && review.findings.some((finding) => SEVERITIES.indexOf(finding.severity) <= SEVERITIES.indexOf(threshold)) ? 1 : 0;
}

export interface CliIo { stdout(text: string): void; stderr(text: string): void }

/** Runs offline unless an explicitly selected project check itself uses the network. No GitHub writes. */
async function executeCli(args: readonly string[], io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  let isolated: ReviewedWorktree | undefined;
  try {
    const options = parseCliArgs(args);
    if (options.help) { io.stdout(CLI_HELP); return 0; }
    const runner = new NodeProcessRunner();
    const git = new GitClient(runner, { timeoutMs: 60_000, maxBytes: 64_000_000 });
    const root = await git.topLevel(options.root);
    if (!root) { throw new Error('Open a Git repository with --root DIR.'); }
    const snapshot = await repositorySnapshot(git, root);
    const changes = await new LocalChangeCollector(git).collect(root, options.scope, { maxFiles: 5000, maxDiffBytes: 64_000_000, maxFileBytes: 2_000_000, exclude: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/target/**', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'] }, undefined, true);
    const workspace = changes.scope.headIsWorkingTree
      ? new GitWorkspaceIndex(git, root, 2_000_000)
      : new RevisionWorkspaceIndex(git, root, changes.scope.kind === 'staged' ? '' : changes.scope.headSha ?? '', 2_000_000);
    let review = await new ReviewEngine(createDefaultAnalyzers(), manifest.version).review(changes, workspace);
    review = { ...review, snapshot: snapshot.fingerprint };
    if ((await repositorySnapshot(git, root)).fingerprint !== snapshot.fingerprint) { throw new Error('Repository changed during review. Run the review again.'); }
    if (options.verify.length > 0 || options.listChecks) {
      await assertReviewCurrent(git, review, undefined, false);
      if (!review.scope.headIsWorkingTree) { isolated = await ReviewedWorktree.create(git, root, review.scope); }
      const executionRoot = isolated?.directory ?? root;
      const plan = await detectMonorepoChecks(executionRoot, process.platform, snapshot.fingerprint, undefined, root);
      if (options.listChecks) {
        io.stdout(`${JSON.stringify(plan.map((check) => ({ id: check.id, command: check.command, cwd: check.cwd, warnings: check.warnings })), null, 2)}\n`);
        return 0;
      }
      const all = options.verify.length === 1 && options.verify[0] === 'all';
      const unknown = options.verify.filter((id) => !all && !plan.some((check) => check.id === id));
      if (unknown.length > 0) { throw new Error(`Unknown checks: ${unknown.join(', ')}. Use --list-checks.`); }
      const approved = all ? plan : plan.filter((check) => options.verify.includes(check.id));
      if (approved.length === 0) { throw new Error('No checks detected. Nothing was executed.'); }
      await isolated?.linkDependencies(approved.map((check) => check.cwd));
      const current = await assertReviewCurrent(git, review, undefined, false);
      const outcome = await new VerificationEngine(runner, git).run({
        repoRoot: executionRoot, dependencyRoot: root, approved,
        baselineCommit: options.baseline ? review.scope.baseSha : undefined,
        headSha: review.scope.headSha ?? current.headSha,
        headDirty: review.scope.kind === 'staged' || (review.scope.headIsWorkingTree && current.dirty),
        timeoutMs: 600_000, maxOutputBytes: 1_000_000,
        progress: (message) => { io.stderr(`${redactSecrets(message)}\n`); },
      });
      await assertReviewCurrent(git, review, undefined, false);
      review = applyVerification(review, outcome);
    }
    if (options.importFile) {
      if ((await stat(options.importFile)).size > 20_000_000) { throw new Error('The SARIF report exceeds the 20 MB import limit.'); }
      review = importSarif(await readFile(options.importFile, 'utf8'), review);
    }
    const report = options.format === 'json' ? renderJson(review) : options.format === 'sarif' ? renderSarif(review) : renderMarkdown(review);
    if (options.output) { await writeFile(options.output, report, 'utf8'); } else { io.stdout(report); }
    return reportExitCode(review, options.failOn);
  } finally {
    await isolated?.dispose();
  }
}

export async function runCli(args: readonly string[], io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  try { return await executeCli(args, io); } catch (error) {
    io.stderr(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

