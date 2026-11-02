import * as path from 'node:path';
import { uniqueId } from '../core/ids';
import { tr } from '../core/i18n';
import type { CheckResult, CheckStatus, CommandEvidence, CommandOutcome, PlannedCheck, Revision } from '../core/model';
import { redactSecrets } from '../core/secrets';
import { formatCommandLine, type ProcessRunner, type RunResult } from '../infrastructure/process-runner';
import type { GitClient } from '../git/git-client';
import { attribute } from './attribution';
import { BaselineWorktree } from './baseline-worktree';
import { parseDiagnostics, type ToolDiagnostic } from './diagnostics-parser';

const EXCERPT_CHARS = 20_000;

export interface VerificationRequest {
  readonly repoRoot: string;
  /** Checks the user explicitly approved. Nothing else is executed. */
  readonly approved: readonly PlannedCheck[];
  /** Re-run failing checks on this commit (user-approved) to attribute failures; undefined disables baselines. */
  readonly baselineCommit: string | undefined;
  readonly headSha: string | undefined;
  readonly headDirty: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly progress?: (message: string) => void;
}

export interface CheckDiagnostics {
  readonly checkId: string;
  readonly head: readonly ToolDiagnostic[];
  readonly introduced: readonly ToolDiagnostic[];
  readonly preExisting: readonly ToolDiagnostic[];
  readonly hasBaseline: boolean;
}

export interface VerificationOutcome {
  readonly checks: readonly CheckResult[];
  readonly evidence: readonly CommandEvidence[];
  readonly diagnostics: readonly CheckDiagnostics[];
  readonly baselineError?: string;
}

function outcomeOf(run: RunResult): CommandOutcome {
  if (run.spawnError) {
    return run.cancelled ? 'cancelled' : 'error';
  }
  if (run.cancelled) {
    return 'cancelled';
  }
  if (run.timedOut) {
    return 'timed-out';
  }
  return run.exitCode === 0 ? 'passed' : 'failed';
}

function statusOf(outcome: CommandOutcome): CheckStatus {
  return outcome;
}

/** Converts a real process run into evidence. This is the only place command evidence is created. */
export function toEvidence(check: PlannedCheck, run: RunResult, revision: Revision, commitSha: string | undefined, dirty: boolean, cwd: string): CommandEvidence {
  const outcome = outcomeOf(run);
  const excerpt = run.output.length > EXCERPT_CHARS ? run.output.slice(-EXCERPT_CHARS) : run.output;
  return {
    kind: 'command-run',
    id: `cmd-${uniqueId()}`,
    checkId: check.id,
    revision,
    commitSha,
    dirty,
    commandLine: formatCommandLine(check.command),
    cwd,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    signal: run.signal,
    outcome,
    outputExcerpt: redactSecrets(excerpt),
    outputTruncated: run.truncated || run.output.length > EXCERPT_CHARS,
    outputSha256: run.outputSha256,
    ...(run.spawnError
      ? {
          errorMessage: /ENOENT/.test(run.spawnError)
            ? tr('"{0}" is not installed or not on PATH ({1}).', check.command.executable, run.spawnError)
            : run.spawnError,
        }
      : {}),
  };
}

export class VerificationEngine {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly git: GitClient,
  ) {}

  async run(request: VerificationRequest): Promise<VerificationOutcome> {
    const evidence: CommandEvidence[] = [];
    const heads = new Map<string, { evidence: CommandEvidence; diagnostics: ToolDiagnostic[] }>();

    for (const check of request.approved) {
      if (request.signal?.aborted) {
        break;
      }
      request.progress?.(tr('Running {0}', check.label));
      const run = await this.runner.run(check.command, {
        cwd: path.join(request.repoRoot, check.cwd),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        capture: 'tail',
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const ev = toEvidence(check, run, 'head', request.headSha, request.headDirty, check.cwd);
      evidence.push(ev);
      heads.set(check.id, { evidence: ev, diagnostics: parseDiagnostics(run.output, check.outputFormat, check.cwd) });
    }

    const failing = request.approved.filter((c) => heads.get(c.id)?.evidence.outcome === 'failed');
    const bases = new Map<string, { evidence: CommandEvidence; diagnostics: ToolDiagnostic[] }>();
    let baselineError: string | undefined;
    if (request.baselineCommit && failing.length > 0 && !request.signal?.aborted) {
      request.progress?.(tr('Preparing base revision worktree'));
      let worktree: BaselineWorktree | undefined;
      try {
        worktree = await BaselineWorktree.create(this.git, request.repoRoot, request.baselineCommit);
        for (const check of failing) {
          if (request.signal?.aborted) {
            break;
          }
          request.progress?.(tr('Running {0} on base revision', check.label));
          const run = await this.runner.run(check.command, {
            cwd: path.join(worktree.directory, check.cwd),
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes,
            capture: 'tail',
            ...(request.signal ? { signal: request.signal } : {}),
          });
          const ev = toEvidence(check, run, 'base', request.baselineCommit, false, check.cwd);
          evidence.push(ev);
          bases.set(check.id, { evidence: ev, diagnostics: parseDiagnostics(run.output, check.outputFormat, check.cwd) });
        }
      } catch (error) {
        baselineError = tr('Baseline could not be prepared: {0}', error instanceof Error ? error.message : String(error));
      } finally {
        await worktree?.dispose().catch((error: unknown) => {
          baselineError = `${baselineError ? `${baselineError} ` : ''}${tr('Temporary worktree cleanup failed: {0}', error instanceof Error ? error.message : String(error))}`;
        });
      }
    }

    const checks: CheckResult[] = [];
    const diagnostics: CheckDiagnostics[] = [];
    for (const check of request.approved) {
      const head = heads.get(check.id);
      if (!head) {
        checks.push({
          checkId: check.id,
          kind: check.kind,
          label: check.label,
          commandLine: formatCommandLine(check.command),
          status: 'pending',
          attribution: 'unknown',
          attributionNote: tr('Not executed (cancelled before it started).'),
        });
        continue;
      }
      const base = bases.get(check.id);
      const result = attribute(head.evidence, base?.evidence, head.diagnostics, base?.diagnostics ?? []);
      const note =
        head.evidence.outcome === 'failed' && !base && baselineError ? `${result.note} ${baselineError}` : head.evidence.errorMessage ?? result.note;
      checks.push({
        checkId: check.id,
        kind: check.kind,
        label: check.label,
        commandLine: head.evidence.commandLine,
        status: statusOf(head.evidence.outcome),
        headEvidenceId: head.evidence.id,
        ...(base ? { baseEvidenceId: base.evidence.id } : {}),
        attribution: result.attribution,
        attributionNote: note,
      });
      diagnostics.push({
        checkId: check.id,
        head: head.diagnostics,
        introduced: result.introducedDiagnostics,
        preExisting: result.preExistingDiagnostics,
        hasBaseline: base !== undefined && (base.evidence.outcome === 'passed' || base.evidence.outcome === 'failed'),
      });
    }
    return { checks, evidence, diagnostics, ...(baselineError ? { baselineError } : {}) };
  }
}
