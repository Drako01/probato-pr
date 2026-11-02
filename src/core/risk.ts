import {
  SEVERITIES,
  VERIFICATION_STATUSES,
  type AnalyzerRun,
  type CheckResult,
  type ReviewFinding,
  type RiskAssessment,
  type RiskLevel,
  type ReviewScope,
  type Severity,
  type SkippedFile,
  type VerificationStatus,
} from './model';
import { tr } from './i18n';

export interface RiskInput {
  readonly findings: readonly ReviewFinding[];
  readonly checks: readonly CheckResult[];
  readonly analyzerRuns: readonly AnalyzerRun[];
  readonly skipped: readonly SkippedFile[];
  readonly scope: ReviewScope;
}

const LEVEL_ORDER: readonly RiskLevel[] = ['unknown', 'low', 'medium', 'high', 'critical'];

function raise(current: RiskLevel, candidate: RiskLevel): RiskLevel {
  return LEVEL_ORDER.indexOf(candidate) > LEVEL_ORDER.indexOf(current) ? candidate : current;
}

const BACKED: ReadonlySet<VerificationStatus> = new Set(['confirmed', 'evidenced']);
const FAILED_STATUSES = new Set(['failed', 'timed-out', 'error']);

/**
 * Explainable risk model. Every level change is tied to a human-readable reason; the result is a
 * label, never a quality guarantee. Passing checks never lower the level below what findings imply.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const byVerification = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, 0])) as Record<VerificationStatus, number>;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const finding of input.findings) {
    byVerification[finding.verification]++;
    bySeverity[finding.severity]++;
  }
  const checks = { passed: 0, failed: 0, notRun: 0 };
  for (const check of input.checks) {
    if (check.status === 'passed') {
      checks.passed++;
    } else if (FAILED_STATUSES.has(check.status)) {
      checks.failed++;
    } else {
      checks.notRun++;
    }
  }
  const regressionChecks = input.checks.filter((c) => c.attribution === 'introduced');
  const regressions = regressionChecks.length + input.findings.filter((f) => f.attribution === 'introduced' && f.origin !== 'verification').length;

  const reasons: string[] = [];
  let level: RiskLevel = 'unknown';
  const ran = input.analyzerRuns.some((r) => r.status === 'ran') || input.checks.length > 0;
  if (ran) {
    level = 'low';
  }

  const count = (severity: Severity, backed: boolean): number =>
    input.findings.filter((f) => f.severity === severity && BACKED.has(f.verification) === backed && f.verification !== 'not-verified').length;

  const backedCritical = count('critical', true);
  if (backedCritical > 0) {
    level = raise(level, 'critical');
    reasons.push(tr('{0} critical finding(s) backed by evidence.', backedCritical));
  }
  if (regressionChecks.length > 0) {
    level = raise(level, 'high');
    reasons.push(
      tr('{0} check(s) pass on the base revision but fail with this change: {1}.', regressionChecks.length, regressionChecks.map((c) => c.label).join(', ')),
    );
  }
  const backedHigh = count('high', true);
  if (backedHigh > 0) {
    level = raise(level, 'high');
    reasons.push(tr('{0} high-severity finding(s) backed by evidence.', backedHigh));
  }
  const suspectedSerious = count('critical', false) + count('high', false);
  if (suspectedSerious > 0) {
    level = raise(level, 'medium');
    reasons.push(tr('{0} critical/high finding(s) are suspected but not verified.', suspectedSerious));
  }
  const failedUnattributed = input.checks.filter((c) => FAILED_STATUSES.has(c.status) && c.attribution !== 'introduced' && c.attribution !== 'pre-existing');
  if (failedUnattributed.length > 0) {
    level = raise(level, 'medium');
    reasons.push(
      tr(
        '{0} check(s) failed without a baseline to attribute the failure: {1}.',
        failedUnattributed.length,
        failedUnattributed.map((c) => c.label).join(', '),
      ),
    );
  }
  const backedMedium = count('medium', true);
  if (backedMedium > 0) {
    level = raise(level, 'medium');
    reasons.push(tr('{0} medium-severity finding(s) backed by evidence.', backedMedium));
  }
  if (reasons.length === 0 && level === 'low') {
    reasons.push(input.findings.length === 0 ? tr('No findings from the analyzers that ran.') : tr('Only low-severity or unverified medium findings.'));
  }

  const limitations: string[] = [];
  if (input.checks.length === 0) {
    limitations.push(tr('No verification commands were executed; findings rely on static analysis only.'));
  } else if (checks.notRun > 0) {
    limitations.push(tr('{0} planned check(s) did not run (cancelled or not approved).', checks.notRun));
  }
  if (checks.passed > 0) {
    limitations.push(tr('Passing checks only cover what the project tests exercise; they do not prove the change is correct.'));
  }
  const preExisting = input.checks.filter((c) => c.attribution === 'pre-existing');
  if (preExisting.length > 0) {
    limitations.push(tr('{0} check(s) also fail on the base revision; failures there are not attributed to this change.', preExisting.length));
  }
  for (const run of input.analyzerRuns) {
    if (run.status === 'ran' && run.detail) {
      limitations.push(tr('Partial analysis ({0}): {1}', run.analyzerId, run.detail));
    }
  }
  const skippedAnalyzers = input.analyzerRuns.filter((r) => r.status === 'failed');
  if (skippedAnalyzers.length > 0) {
    limitations.push(
      tr('Analyzer(s) failed: {0}.', skippedAnalyzers.map((r) => `${r.analyzerId} (${r.detail ?? tr('unknown error')})`).join('; ')),
    );
  }
  if (input.skipped.length > 0) {
    limitations.push(tr('{0} changed file(s) were not analyzed (excluded or over limits).', input.skipped.length));
  }
  if (input.scope.kind === 'pull-request' && input.checks.length === 0) {
    limitations.push(tr('Pull request reviewed from the GitHub API; checks require the PR head checked out locally.'));
  }
  if (byVerification['not-verified'] > 0) {
    limitations.push(tr('{0} finding(s) could not be verified.', byVerification['not-verified']));
  }

  return { level, reasons, limitations, counts: { byVerification, bySeverity, checks, regressions } };
}
