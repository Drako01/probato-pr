import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import manifest from '../package.json';
import { compareReviews } from './core/review-comparison';
import { loadRepositoryPolicy } from './infrastructure/repository-policy';
import { applyReviewPolicy } from './core/repository-policy';
import { readStoredReview } from './infrastructure/history-schema';
import { recommendChecks } from './verification/check-impact';
import { tr, setTranslator, formatMessage } from './core/i18n';
import spanish from '../l10n/bundle.l10n.es.json';
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
  readonly compareFile?: string;
  readonly mutation: boolean;
  readonly mutationBaseline: boolean;
  readonly locale: 'en' | 'es';
  readonly mutationLimits: { readonly timeoutMs: number; readonly concurrency: number; readonly memoryMb: number; readonly maxFiles: number };
  readonly mutationGate: boolean;
  readonly mutationFailOnDegradation: boolean;
  readonly help: boolean;
}

export function cliHelp(): string {
  return [
    tr('Probato PR — local, evidence-based review'),
    tr('Usage: {0}', 'probato-pr [--root DIR] [--scope working|staged|branch|commit]'),
    "  --base REF                     " + tr('Base branch for branch review'),
    "  --ref REF                      " + tr('Commit for commit review (default HEAD)'),
    "  --format json|markdown|sarif    " + tr('Report format (default markdown)'),
    "  --output FILE                  " + tr('Write the report instead of stdout'),
    "  --fail-on critical|high|medium|low|none   " + tr('Finding threshold (default high)'),
    "  --list-checks                  " + tr('List detected check IDs without executing them'),
    "  --verify ID,ID | all           " + tr('Explicitly authorize these project checks'),
    "  --baseline                     " + tr('Explicitly authorize repeating failed checks on base'),
    "  --import-sarif FILE            " + tr('Merge external diagnostics as unconfirmed evidence'),
    "  --compare FILE                " + tr('Compare with a previous Probato JSON report (observational only)'),
    "  --mutation                    " + tr('Explicitly authorize optional local Stryker testing on impacted source'),
    "  --mutation-baseline           " + tr('Also authorize mutation testing on the real base commit'),
    "  --mutation-timeout SECONDS     " + tr('Total mutation timeout (default 600; 5..7200)'),
    "  --mutation-concurrency N       " + tr('Worker count (default 1; 1..8)'),
    "  --mutation-memory MB           " + tr('Per-process Node heap budget (default 1024; 256..8192)'),
    "  --mutation-max-files N         " + tr('Maximum impacted files (default 30; 1..100)'),
    "  --mutation-gate                " + tr('Enable the separate mutation quality gate'),
    tr('  --mutation-fail-on-degradation Fail that gate on a comparable score decrease'),
    "  --locale en|es                 " + tr('Language for report labels (default en)'),
    "  --help                        " + tr('Show this help'),
    tr('Exit codes: 0 threshold not reached; 1 findings meet threshold; 2 execution/configuration error.'),
    tr('Checks execute repository code with your permissions. Nothing is installed automatically.'),
  ].join('\n') + '\n';
}
export const CLI_HELP = cliHelp();

export function parseCliArgs(args: readonly string[], cwd = process.cwd()): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleans = new Set(['--baseline', '--list-checks', '--help', '--mutation', '--mutation-baseline', '--mutation-gate', '--mutation-fail-on-degradation']);
  const named = new Set(['--root', '--scope', '--base', '--ref', '--format', '--output', '--fail-on', '--verify', '--import-sarif', '--compare', '--locale', '--mutation-timeout', '--mutation-concurrency', '--mutation-memory', '--mutation-max-files']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) { continue; }
    if (booleans.has(arg)) { flags.add(arg); continue; }
    if (!named.has(arg)) { throw new Error(tr('Unknown option: {0}', arg)); }
    const value = args[++index];
    if (!value || value.startsWith('--')) { throw new Error(tr('Missing value for {0}', arg)); }
    if (values.has(arg)) { throw new Error(tr('Duplicate option: {0}', arg)); }
    values.set(arg, value);
  }
  const kind = values.get('--scope') ?? 'working';
  let scope: LocalReviewRequest;
  if (kind === 'working' || kind === 'staged') { scope = { kind }; }
  else if (kind === 'branch') {
    const baseBranch = values.get('--base');
    if (!baseBranch) { throw new Error(tr('--scope branch requires --base REF.')); }
    scope = { kind, baseBranch };
  } else if (kind === 'commit') { scope = { kind, ref: values.get('--ref') ?? 'HEAD' }; }
  else { throw new Error(tr('Unknown scope: {0}', kind)); }
  if (values.has('--base') && kind !== 'branch') { throw new Error(tr('--base applies only to branch scope.')); }
  if (values.has('--ref') && kind !== 'commit') { throw new Error(tr('--ref applies only to commit scope.')); }
  const format = values.get('--format') ?? 'markdown';
  if (format !== 'json' && format !== 'markdown' && format !== 'sarif') { throw new Error(tr('Unknown format: {0}', format)); }
  const failOn = values.get('--fail-on') ?? 'high';
  if (failOn !== 'none' && !SEVERITIES.includes(failOn as Severity)) { throw new Error(tr('Unknown severity: {0}', failOn)); }
  const output = values.get('--output'), importFile = values.get('--import-sarif'), compareFile = values.get('--compare');
  const locale = values.get('--locale') ?? 'en';
  if (locale !== 'en' && locale !== 'es') throw new Error(tr('Supported report languages are en and es.'));
  const bounded = (name: string, fallback: number, min: number, max: number): number => {
    const number = Number(values.get(name) ?? fallback);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(tr('Invalid {0}: choose an integer between {1} and {2}.', name, min, max));
    return number;
  };
  if (!flags.has('--mutation') && [...flags, ...values.keys()].some((flag) => flag.startsWith('--mutation-'))) throw new Error(tr('Mutation options require explicit --mutation authorization.'));
  return {
    root: path.resolve(cwd, values.get('--root') ?? '.'), scope, format, failOn: failOn as Severity | 'none',
    verify: (values.get('--verify') ?? '').split(',').filter(Boolean), baseline: flags.has('--baseline'), listChecks: flags.has('--list-checks'), help: flags.has('--help'),
    locale, mutation: flags.has('--mutation'), mutationBaseline: flags.has('--mutation-baseline'),
    mutationGate: flags.has('--mutation-gate'), mutationFailOnDegradation: flags.has('--mutation-fail-on-degradation'),
    mutationLimits: { timeoutMs: bounded('--mutation-timeout', 600, 5, 7200) * 1000, concurrency: bounded('--mutation-concurrency', 1, 1, 8), memoryMb: bounded('--mutation-memory', 1024, 256, 8192), maxFiles: bounded('--mutation-max-files', 30, 1, 100) },
    ...(compareFile ? { compareFile: path.resolve(cwd, compareFile) } : {}),
    ...(output ? { output: path.resolve(cwd, output) } : {}), ...(importFile ? { importFile: path.resolve(cwd, importFile) } : {}),
  };
}

export function reportExitCode(review: ReviewResult, threshold: Severity | 'none'): number {
  // Incomplete execution takes precedence over a simultaneous demonstrated quality failure.
  if (review.analyzerRuns.some((run) => run.status === 'failed') || review.checks.some((check) => check.status === 'error' || check.status === 'timed-out' || check.status === 'cancelled' || check.status === 'pending')) return 2;
  const mutation = review.mutation;
  if (mutation && (mutation.execution.status !== 'COMPLETED' || mutation.verification.status === 'ERROR' || mutation.verification.status === 'INCONCLUSIVE' || mutation.head?.timedOut || mutation.base?.timedOut || (mutation.policy.enabled && mutation.gate.decision === 'INCONCLUSIVE'))) return 2;
  if (mutation?.gate.decision === 'FAIL' || review.checks.some((check) => check.status === 'failed')) return 1;
  return threshold !== 'none' && review.findings.some((finding) => SEVERITIES.indexOf(finding.severity) <= SEVERITIES.indexOf(threshold)) ? 1 : 0;
}

export interface CliIo { stdout(text: string): void; stderr(text: string): void }

/** Runs offline unless an explicitly selected project check itself uses the network. No GitHub writes. */
async function executeCli(args: readonly string[], io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  let isolated: ReviewedWorktree | undefined;
  try {
    const requestedLocale = args.indexOf('--locale');
    if (requestedLocale >= 0 && args[requestedLocale + 1] === 'es') { const dictionary: Record<string, string> = spanish; setTranslator((template, ...values) => formatMessage(dictionary[template] ?? template, values)); }
    const options = parseCliArgs(args);
    if (options.locale === 'es') { const dictionary: Record<string, string> = spanish; setTranslator((template, ...args) => formatMessage(dictionary[template] ?? template, args)); }
    if (options.help) { io.stdout(cliHelp()); return 0; }
    const runner = new NodeProcessRunner();
    const git = new GitClient(runner, { timeoutMs: 60_000, maxBytes: 64_000_000 });
    const root = await git.topLevel(options.root);
    if (!root) { throw new Error(tr('Open a Git repository with --root DIR.')); }
    const snapshot = await repositorySnapshot(git, root);
    const changes = await new LocalChangeCollector(git).collect(root, options.scope, { maxFiles: 5000, maxDiffBytes: 64_000_000, maxFileBytes: 2_000_000, exclude: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/target/**', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'] }, undefined, true);
    const workspace = changes.scope.headIsWorkingTree
      ? new GitWorkspaceIndex(git, root, 2_000_000)
      : new RevisionWorkspaceIndex(git, root, changes.scope.kind === 'staged' ? '' : changes.scope.headSha ?? '', 2_000_000);
    let review = await new ReviewEngine(createDefaultAnalyzers(), manifest.version).review(changes, workspace);
    const loadedPolicy = await loadRepositoryPolicy(root, workspace);
    if (loadedPolicy.warnings.length) throw new Error(tr('Invalid repository policy prevents a reliable CLI quality gate: {0}', loadedPolicy.warnings.join(' ')));
    if (loadedPolicy.policy) review = applyReviewPolicy(review, loadedPolicy.policy);
    review = { ...review, snapshot: snapshot.fingerprint,
      ...(loadedPolicy.warnings.length ? { policyNotes: [...(review.policyNotes ?? []), ...loadedPolicy.warnings], risk: { ...review.risk, limitations: [...review.risk.limitations, ...loadedPolicy.warnings] } } : {}),
    };
    if ((await repositorySnapshot(git, root)).fingerprint !== snapshot.fingerprint) { throw new Error(tr('Repository changed during review. Run the review again.')); }
    if (options.verify.length > 0 || options.listChecks) {
      await assertReviewCurrent(git, review, undefined, false);
      if (!review.scope.headIsWorkingTree) { isolated = await ReviewedWorktree.create(git, root, review.scope); }
      const executionRoot = isolated?.directory ?? root;
      const plan = await detectMonorepoChecks(executionRoot, process.platform, snapshot.fingerprint, undefined, root);
      if (options.listChecks) {
        const impact = recommendChecks(plan, review.changedFiles, loadedPolicy.policy);
        io.stdout(`${JSON.stringify(plan.map((check) => ({ id: check.id, command: check.command, cwd: check.cwd, warnings: check.warnings, recommendation: impact.recommendations.find((item) => item.checkId === check.id) })), null, 2)}\n`);
        return 0;
      }
      const all = options.verify.length === 1 && options.verify[0] === 'all';
      const unknown = options.verify.filter((id) => !all && !plan.some((check) => check.id === id));
      if (unknown.length > 0) { throw new Error(tr('Unknown checks: {0}. Use --list-checks.', unknown.join(', '))); }
      const approved = all ? plan : plan.filter((check) => options.verify.includes(check.id));
      if (approved.length === 0) { throw new Error(tr('No checks detected. Nothing was executed.')); }
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
      if ((await stat(options.importFile)).size > 20_000_000) { throw new Error(tr('The SARIF report exceeds the 20 MB import limit.')); }
      review = importSarif(await readFile(options.importFile, 'utf8'), review);
    }
    if (options.mutation) {
      const { MutationEngine, discoverImpactedMutationFiles, mutationCommandEvidence } = await import('./mutation');
      await assertReviewCurrent(git, review, undefined, false);
      if (!review.scope.headIsWorkingTree && !isolated) isolated = await ReviewedWorktree.create(git, root, review.scope);
      const executionRoot = isolated?.directory ?? root;
      const impactedFiles = await discoverImpactedMutationFiles(review.changedFiles, workspace);
      const mutation = await new MutationEngine(runner, git).run({
        root: executionRoot, dependencyRoot: root, authorized: true, impactedFiles,
        ...(options.mutationBaseline && review.scope.baseSha ? { baseCommit: review.scope.baseSha } : {}),
        ...(review.scope.headSha ? { headCommit: review.scope.headSha } : review.repository.headSha ? { headCommit: review.repository.headSha } : {}),
        limits: options.mutationLimits,
        gatePolicy: { minimumScore: loadedPolicy.policy?.mutation?.minimumScore ?? 0, tolerancePoints: loadedPolicy.policy?.mutation?.tolerancePoints ?? 0, enabled: options.mutationGate || loadedPolicy.policy?.mutation?.enabled === true, failOnDegradation: options.mutationFailOnDegradation || loadedPolicy.policy?.mutation?.failOnDegradation === true },
        progress: (message) => { io.stderr(`${redactSecrets(message)}\n`); },
      });
      await assertReviewCurrent(git, review, undefined, false);
      review = { ...review, mutation, evidence: [...review.evidence, ...mutationCommandEvidence(mutation)] };
    }
    let comparison;
    if (options.compareFile) {
      if ((await stat(options.compareFile)).size > 4_000_000) throw new Error(tr('The previous review report exceeds the 4 MB comparison limit.'));
      const previous = readStoredReview(JSON.parse(await readFile(options.compareFile, 'utf8')) as unknown);
      if (!previous) throw new Error(tr('The previous review report is invalid or unsupported.'));
      comparison = compareReviews(previous, review);
    }
    const report = options.format === 'json' ? renderJson(review, comparison) : options.format === 'sarif' ? renderSarif(review) : renderMarkdown(review, comparison);
    if (options.output) { await writeFile(options.output, report, 'utf8'); } else { io.stdout(report); }
    return reportExitCode(review, options.failOn);
  } finally {
    await isolated?.dispose();
    setTranslator(undefined);
  }
}

export async function runCli(args: readonly string[], io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  try { return await executeCli(args, io); } catch (error) {
    io.stderr(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

