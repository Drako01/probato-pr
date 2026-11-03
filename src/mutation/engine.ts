import { open, lstat, mkdir, copyFile, rm, writeFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { tr } from '../core/i18n';
import { uniqueId } from '../core/ids';
import { resolveInside } from '../core/paths';
import { redactSecrets } from '../core/secrets';
import type { CommandEvidence } from '../core/model';
import type { GitClient } from '../git/git-client';
import type { ProcessRunner } from '../infrastructure/process-runner';
import { formatCommandLine } from '../infrastructure/process-runner';
import { compareDependencyInputs, dependencyProbe } from '../verification/dependency-comparability';
import { BaselineWorktree } from '../verification/baseline-worktree';
import { DEFAULT_MUTATION_LIMITS, DEFAULT_MUTATION_POLICY, type MutationExecution, type MutationGatePolicy, type MutationLimits, type MutationResult, type MutationRunEvidence } from './model';
import { compareMutationRuns } from './compare';
import { mutationHash, parseStrykerReport } from './report';
import { startMutationExecution, transitionMutationExecution } from './state';

export interface MutationRequest {
  readonly root: string; readonly dependencyRoot?: string; readonly baseCommit?: string; readonly headCommit?: string;
  readonly impactedFiles: readonly string[]; readonly authorized: boolean; readonly limits?: Partial<MutationLimits>;
  readonly gatePolicy?: Partial<MutationGatePolicy>; readonly signal?: AbortSignal;
  readonly progress?: (message: string) => void; readonly onUpdate?: (result: MutationResult) => void;
}
class MutationBudgetError extends Error {}
class MutationBaselineError extends Error {}
function assertBudget(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(tr('Mutation execution was cancelled.'));
  if (Date.now() >= deadline) throw new MutationBudgetError(tr('The total mutation time budget expired before another process could start.'));
}
const INPUTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
async function boundedText(root: string, file: string, limit = 4_000_000): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(await resolveInside(root, file), 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(tr('Mutation input exceeds its safe read limit: {0}.', file));
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(tr('Mutation input exceeds its safe read limit: {0}.', file));
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

function limitsFor(request: MutationRequest): MutationLimits {
  const value = { ...DEFAULT_MUTATION_LIMITS, ...request.limits };
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 7_200_000 || !Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 8 || !Number.isInteger(value.memoryMb) || value.memoryMb < 128 || value.memoryMb > 8192 || !Number.isInteger(value.maxFiles) || value.maxFiles < 1 || value.maxFiles > 200 || !Number.isInteger(value.maxReportBytes) || value.maxReportBytes < 1000 || value.maxReportBytes > 50_000_000) throw new Error(tr('Invalid mutation resource limits.'));
  return value;
}
function policyFor(request: MutationRequest): MutationGatePolicy {
  const policy = { ...DEFAULT_MUTATION_POLICY, ...request.gatePolicy };
  if (typeof policy.enabled !== 'boolean' || typeof policy.failOnDegradation !== 'boolean' || !Number.isFinite(policy.tolerancePoints) || policy.tolerancePoints < 0 || policy.tolerancePoints > 100 || (policy.minimumScore !== undefined && (!Number.isFinite(policy.minimumScore) || policy.minimumScore < 0 || policy.minimumScore > 100))) throw new Error(tr('Invalid mutation quality gate policy.'));
  return policy;
}
export function createMutationResult(request: MutationRequest): MutationResult {
  const policy = policyFor(request);
  return { schemaVersion: 1, execution: startMutationExecution(), verification: { status: 'SKIP', reasons: [tr('Mutation testing has not been requested.')] }, baseline: { status: 'MISSING', reasons: [tr('No measured mutation baseline is available.')] }, quality: { trend: 'NOT_APPLICABLE', metric: 'stryker-mutation-score', reasons: [] }, gate: { decision: policy.enabled ? 'INCONCLUSIVE' : 'SKIP', reasons: [policy.enabled ? tr('The quality gate awaits an authorized mutation result.') : tr('The mutation quality gate is disabled.')] }, impactedFiles: [...request.impactedFiles], limits: limitsFor(request), policy };
}
export function cancelPendingMutation(result: MutationResult): MutationResult {
  const at = new Date().toISOString();
  return { ...result, execution: transitionMutationExecution(result.execution, 'CANCELLED', tr('Mutation testing was cancelled before execution.'), at), verification: { status: 'INCONCLUSIVE', reasons: [tr('Mutation testing was cancelled before execution.')] }, gate: { decision: result.policy.enabled ? 'INCONCLUSIVE' : 'SKIP', reasons: [tr('Cancellation cannot produce a successful quality gate.')] }, finishedAt: at };
}
async function copyReviewedFiles(git: GitClient, from: string, to: string, deadline: number, signal?: AbortSignal): Promise<void> {
  const files = (await git.exec(from, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBytes: 8_000_000 })).split('\0').filter(Boolean);
  const visible = new Set(files);
  const targetFiles = (await git.exec(to, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of targetFiles) {
    assertBudget(deadline, signal);
    // Git can report a directory symlink as an untracked file on POSIX even when node_modules/ is ignored.
    // Dependency links belong to BaselineWorktree and must never be reconciled as reviewed source.
    if (file.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules')) continue;
    if (!visible.has(file)) await rm(await resolveInside(to, file), { force: true });
  }
  if (files.length > 25_000) throw new Error(tr('The mutation snapshot exceeds the 25000-file limit.'));
  let bytes = 0;
  for (const file of files) {
    assertBudget(deadline, signal);
    if (file.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules')) continue;
    const target = await resolveInside(to, file), source = await resolveInside(from, file);
    let info;
    try { info = await lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await rm(target, { force: true }); continue; } throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(tr('Mutation snapshots cannot follow source symlinks: {0}.', file));
    bytes += info.size; if (bytes > 256_000_000) throw new Error(tr('The mutation snapshot exceeds the 256 MB limit.'));
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target);
  }
}
/** Executes the installed Stryker CLI in isolated checkouts through the existing bounded ProcessRunner. */
export class MutationEngine {
  constructor(private readonly runner: ProcessRunner, private readonly git: GitClient) {}
  async run(request: MutationRequest): Promise<MutationResult> {
    let result = createMutationResult(request);
    const notify = () => { request.onUpdate?.(result); };
    const update = (status: Exclude<MutationExecution['status'], 'COMPLETED' | 'CANCELLED'>, cause: string) => { result = { ...result, execution: transitionMutationExecution(result.execution, status, cause) }; notify(); };
    const finish = (status: 'COMPLETED' | 'CANCELLED', cause: string, assessment: Partial<MutationResult> = {}) => {
      const at = new Date().toISOString();
      result = { ...result, ...assessment, execution: transitionMutationExecution(result.execution, status, cause, at), finishedAt: at };
      notify();
      return result;
    };
    update('AWAITING_APPROVAL', tr('Mutation testing requires explicit authorization.'));
    if (!request.authorized) return result;
    if (request.signal?.aborted) { result = cancelPendingMutation(result); request.onUpdate?.(result); return result; }
    update('QUEUED', tr('Mutation testing was explicitly authorized.'));
    update('RUNNING', tr('Preparing isolated mutation execution.'));
    const deadline = Date.now() + result.limits.timeoutMs;
    const finishWithoutRun = (status: 'SKIP' | 'ERROR' | 'INCONCLUSIVE', reason: string) => {
      return finish('COMPLETED', reason, { verification: { status, reasons: [reason] }, gate: { decision: result.policy.enabled ? 'INCONCLUSIVE' : 'SKIP', reasons: [reason] }, quality: { ...result.quality, trend: request.baseCommit ? 'INCONCLUSIVE' : 'NOT_APPLICABLE', reasons: [reason] } });
    };
    try {
      const files = [...new Set(request.impactedFiles)].sort();
      if (!files.length) return finishWithoutRun('SKIP', tr('No impacted JavaScript or TypeScript source was identified for mutation testing.'));
      if (files.length > result.limits.maxFiles || files.some((file) => !/^[a-zA-Z0-9_./ -]+\.(?:[cm]?[jt]sx?)$/i.test(file) || file.startsWith('/') || file.split('/').includes('..'))) return finishWithoutRun('SKIP', tr('The authorized mutation impact is invalid or exceeds the configured file limit.'));
      const dependencies = request.dependencyRoot ?? request.root;
      const packageText = await boundedText(dependencies, 'node_modules/@stryker-mutator/core/package.json');
      if (!packageText) return finishWithoutRun('SKIP', tr('Stryker is not installed locally. Probato does not install mutation dependencies automatically.'));
      const pkg = JSON.parse(packageText) as { name?: unknown; version?: unknown; bin?: Record<string, string> };
      if (pkg.name !== '@stryker-mutator/core' || typeof pkg.version !== 'string' || !pkg.bin?.stryker) return finishWithoutRun('ERROR', tr('The installed Stryker package metadata is invalid.'));
      const bin = await resolveInside(dependencies, path.posix.join('node_modules/@stryker-mutator/core', pkg.bin.stryker));
      const configText = await boundedText(request.root, 'stryker.config.json', 65_536);
      if (!configText) return finishWithoutRun('SKIP', tr('Initial mutation integration requires an existing stryker.config.json. JavaScript configuration is not executed by Probato.'));
      const originalConfig: unknown = JSON.parse(configText);
      if (!originalConfig || typeof originalConfig !== 'object' || Array.isArray(originalConfig)) return finishWithoutRun('ERROR', tr('The Stryker JSON configuration must be an object.'));
      const headCommit = request.headCommit ?? await this.git.resolveCommit(request.root, 'HEAD');
      if (!headCommit) return finishWithoutRun('SKIP', tr('A committed revision is required to prepare isolated mutation testing.'));
      const head = await this.runRevision(request, files, headCommit, 'head', dependencies, bin, pkg.version, originalConfig as Record<string, unknown>, result.limits, deadline);
      result = { ...result, head };
      let base: MutationRunEvidence | undefined;
      if (!head.cancelled && !head.timedOut && (head.exitCode === 0 || head.thresholdFailure) && request.baseCommit && !request.signal?.aborted) base = await this.runRevision(request, files, request.baseCommit, 'base', dependencies, bin, pkg.version, originalConfig as Record<string, unknown>, result.limits, deadline);
      if (base) result = { ...result, base };
      const assessment = compareMutationRuns(head, base, result.policy, Boolean(request.baseCommit));
      result = { ...result, ...assessment };
      const cancelled = head.cancelled || Boolean(base?.cancelled) || request.signal?.aborted;
      if (cancelled) result = { ...result, verification: { status: 'INCONCLUSIVE', reasons: [tr('Mutation execution was cancelled.')] }, gate: { decision: result.policy.enabled ? 'INCONCLUSIVE' : 'SKIP', reasons: [tr('Cancellation cannot produce a successful quality gate.')] } };
      return finish(cancelled ? 'CANCELLED' : 'COMPLETED', cancelled ? tr('Mutation execution was cancelled.') : tr('Mutation execution finished; verification and gate decisions are evaluated separately.'));
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      if (request.signal?.aborted) return finish('CANCELLED', reason, { verification: { status: 'INCONCLUSIVE', reasons: [reason] }, gate: { decision: result.policy.enabled ? 'INCONCLUSIVE' : 'SKIP', reasons: [reason] }, quality: { ...result.quality, trend: request.baseCommit ? 'INCONCLUSIVE' : 'NOT_APPLICABLE', reasons: [reason] } });
      return finishWithoutRun(error instanceof MutationBudgetError || error instanceof MutationBaselineError ? 'INCONCLUSIVE' : 'ERROR', reason);
    }
  }
  private async runRevision(request: MutationRequest, files: readonly string[], commit: string, revision: 'head' | 'base', dependencies: string, bin: string, strykerVersion: string, originalConfig: Record<string, unknown>, limits: MutationLimits, deadline: number): Promise<MutationRunEvidence> {
    assertBudget(deadline, request.signal);
    const started = new Date().toISOString();
    const dirty = revision === 'head' && Boolean((await this.git.exec(request.root, ['status', '--porcelain', '--untracked-files=all'])).trim());
    const worktree = await BaselineWorktree.create(this.git, request.root, commit, [''], dependencies);
    try {
      if (revision === 'head') await copyReviewedFiles(this.git, request.root, worktree.directory, deadline, request.signal);
      const configSource = await boundedText(worktree.directory, 'stryker.config.json', 65_536);
      if (!configSource && revision === 'base') throw new MutationBaselineError(tr('The baseline has no Stryker JSON configuration; reviewed settings are not substituted.'));
      const config = configSource ? JSON.parse(configSource) as Record<string, unknown> : originalConfig;
      const reportFile = 'probato-mutation-report.json';
      const controlled = { ...config, mutate: [...files], inPlace: false, incremental: false, reporters: ['json'], jsonReporter: { fileName: reportFile }, tempDirName: '.probato-stryker-tmp', cleanTempDir: true, concurrency: limits.concurrency, timeoutMS: Math.min(5000, limits.timeoutMs), ...(config.testRunner === 'command' ? {} : { testRunnerNodeArgs: [`--max-old-space-size=${limits.memoryMb}`] }) };
      const configName = '.probato-stryker.config.json';
      await writeFile(path.join(worktree.directory, configName), JSON.stringify(controlled), { encoding: 'utf8', mode: 0o600 });
      const sources: [string, string][] = [];
      for (const file of files) { const source = await boundedText(worktree.directory, file, 2_000_000); if (source === undefined) throw new Error(tr('An impacted mutation source is absent from revision {0}: {1}.', revision, file)); sources.push([file, source.replace(/\r\n/g, '\n')]); }
      const dependencyInputs: [string, string | undefined][] = [];
      for (const file of INPUTS) dependencyInputs.push([file, (await boundedText(worktree.directory, file))?.replace(/\r\n/g, '\n')]);
      const installedLock = await boundedText(dependencies, 'node_modules/.package-lock.json') ?? await boundedText(dependencies, 'node_modules/.pnpm/lock.yaml');
      if (!installedLock && dependencyInputs.some(([file, text]) => file !== 'package.json' && text !== undefined)) throw new Error(tr('Installed dependency metadata is unavailable for reproducible mutation testing.'));
      const dependencyAssessment = await compareDependencyInputs(dependencyProbe(worktree.directory), dependencyProbe(worktree.directory), dependencyProbe(dependencies), '');
      const dependencyVersions: Record<string, string> = {};
      const packageLock = dependencyInputs.find(([file]) => file === 'package-lock.json')?.[1];
      if (packageLock) { const lock = JSON.parse(packageLock) as { packages?: Record<string, { version?: string }> }; for (const [name, value] of Object.entries(lock.packages ?? {})) if (value.version) dependencyVersions[name || '(project)'] = value.version; }
      const testFiles = (await this.git.exec(worktree.directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter((file) => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)).sort();
      const testInputs: [string, string | undefined][] = [];
      for (const file of testFiles) testInputs.push([file, await boundedText(worktree.directory, file)]);
      const command = { executable: process.execPath, args: [`--max-old-space-size=${limits.memoryMb}`, await realpath(bin), 'run', configName] };
      assertBudget(deadline, request.signal);
      const remaining = deadline - Date.now();
      request.progress?.(tr('Running mutation testing on the {0} revision.', revision));
      const run = await this.runner.run(command, { cwd: worktree.directory, timeoutMs: remaining, maxOutputBytes: 1_000_000, capture: 'tail', ...(request.signal ? { signal: request.signal } : {}), env: { NODE_OPTIONS: `--max-old-space-size=${limits.memoryMb}` } });
      const metadata = { commit, dependencyStatus: dependencyAssessment.status, dependencyReasons: dependencyAssessment.reasons, testHash: mutationHash(JSON.stringify(testInputs)), sourceHash: mutationHash(JSON.stringify(sources)), dependencyHash: mutationHash(JSON.stringify([dependencyInputs, installedLock])), configurationHash: mutationHash(JSON.stringify(controlled)), nodeVersion: process.version, strykerVersion, runner: typeof config.testRunner === 'string' ? config.testRunner : 'unknown', dependencyVersions, conditionsHash: mutationHash(JSON.stringify([process.platform, process.arch, process.version, strykerVersion, limits, controlled])) };
      let report;
      let reportSha256: string | undefined;
      let error = run.spawnError ? redactSecrets(run.spawnError) : undefined;
      if (!run.cancelled && !run.timedOut && !run.spawnError && (run.exitCode === 0 || run.exitCode === 1)) {
        try {
          const text = await boundedText(worktree.directory, reportFile, limits.maxReportBytes);
          if (!text) error = tr('Stryker completed without its required structured mutation report.');
          else {
            reportSha256 = mutationHash(text);
            const parsed = parseStrykerReport(JSON.parse(text) as unknown, files);
            if (parsed.sourceHash !== metadata.sourceHash) throw new Error(tr('The Stryker report source differs from the authorized snapshot.'));
            report = { schemaVersion: parsed.schemaVersion, metrics: parsed.metrics, mutants: parsed.mutants };
          }
        } catch (failure) { error = redactSecrets(failure instanceof Error ? failure.message : String(failure)); }
      }
      const thresholds = config.thresholds;
      const absoluteThreshold = thresholds && typeof thresholds === 'object' && 'break' in thresholds && typeof thresholds.break === 'number' ? thresholds.break : undefined;
      const thresholdFailure = run.exitCode === 1 && absoluteThreshold !== undefined && report?.metrics.mutationScore !== undefined && report.metrics.mutationScore < absoluteThreshold;
      return { ...(absoluteThreshold !== undefined ? { absoluteThreshold } : {}), ...(thresholdFailure ? { thresholdFailure: true } : {}), id: `mutation-${revision}-${uniqueId()}`, revision, startedAt: run.startedAt || started, finishedAt: new Date().toISOString(), durationMs: run.durationMs, commandLine: formatCommandLine(command), exitCode: run.exitCode, timedOut: run.timedOut, cancelled: run.cancelled, cwd: worktree.directory, signal: run.signal, dirty, outputTruncated: run.truncated || redactSecrets(run.output).length > 20_000, outputSha256: run.outputSha256, outputExcerpt: redactSecrets(run.output).slice(-20_000), reproducibility: metadata, ...(report ? { report } : {}), ...(reportSha256 ? { reportSha256 } : {}), ...(error ? { error } : {}) };
    } finally { await worktree.dispose(); }
  }
}
/** Only actual process runs become existing command evidence; missing tools/configuration never create evidence. */
export function mutationCommandEvidence(result: MutationResult): readonly CommandEvidence[] {
  return [result.head, result.base].filter((run): run is MutationRunEvidence => run !== undefined).map((run) => ({ kind: 'command-run', id: run.id, checkId: 'stryker-mutation', revision: run.revision, commitSha: run.reproducibility?.commit, dirty: run.dirty ?? false, commandLine: run.commandLine, cwd: run.cwd ?? '', startedAt: run.startedAt, durationMs: run.durationMs, exitCode: run.exitCode, signal: run.signal ?? null, outcome: run.cancelled ? 'cancelled' : run.timedOut ? 'timed-out' : run.thresholdFailure ? 'failed' : run.exitCode !== 0 || run.error ? 'error' : 'passed', outputExcerpt: run.outputExcerpt, outputTruncated: run.outputTruncated ?? false, outputSha256: run.outputSha256, ...(run.error ? { errorMessage: run.error } : {}) }));
}
