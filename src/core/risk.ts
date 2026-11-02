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
    reasons.push(`${backedCritical} critical finding(s) backed by evidence.`);
  }
  if (regressionChecks.length > 0) {
    level = raise(level, 'high');
    reasons.push(`${regressionChecks.length} check(s) pass on the base revision but fail with this change: ${regressionChecks.map((c) => c.label).join(', ')}.`);
  }
  const backedHigh = count('high', true);
  if (backedHigh > 0) {
    level = raise(level, 'high');
    reasons.push(`${backedHigh} high-severity finding(s) backed by evidence.`);
  }
  const suspectedSerious = count('critical', false) + count('high', false);
  if (suspectedSerious > 0) {
    level = raise(level, 'medium');
    reasons.push(`${suspectedSerious} critical/high finding(s) are suspected but not verified.`);
  }
  const failedUnattributed = input.checks.filter((c) => FAILED_STATUSES.has(c.status) && c.attribution !== 'introduced' && c.attribution !== 'pre-existing');
  if (failedUnattributed.length > 0) {
    level = raise(level, 'medium');
    reasons.push(`${failedUnattributed.length} check(s) failed without a baseline to attribute the failure: ${failedUnattributed.map((c) => c.label).join(', ')}.`);
  }
  const backedMedium = count('medium', true);
  if (backedMedium > 0) {
    level = raise(level, 'medium');
    reasons.push(`${backedMedium} medium-severity finding(s) backed by evidence.`);
  }
  if (reasons.length === 0 && level === 'low') {
    reasons.push(input.findings.length === 0 ? 'No findings from the analyzers that ran.' : 'Only low-severity or unverified medium findings.');
  }

  const limitations: string[] = [];
  if (input.checks.length === 0) {
    limitations.push('No verification commands were executed; findings rely on static analysis only.');
  } else if (checks.notRun > 0) {
    limitations.push(`${checks.notRun} planned check(s) did not run (cancelled or not approved).`);
  }
  if (checks.passed > 0) {
    limitations.push('Passing checks only cover what the project tests exercise; they do not prove the change is correct.');
  }
  const preExisting = input.checks.filter((c) => c.attribution === 'pre-existing');
  if (preExisting.length > 0) {
    limitations.push(`${preExisting.length} check(s) also fail on the base revision; failures there are not attributed to this change.`);
  }
  for (const run of input.analyzerRuns) {
    if (run.status === 'ran' && run.detail) {
      limitations.push(`Partial analysis (${run.analyzerId}): ${run.detail}`);
    }
  }
  const skippedAnalyzers = input.analyzerRuns.filter((r) => r.status === 'failed');
  if (skippedAnalyzers.length > 0) {
    limitations.push(`Analyzer(s) failed: ${skippedAnalyzers.map((r) => `${r.analyzerId} (${r.detail ?? 'unknown error'})`).join('; ')}.`);
  }
  if (input.skipped.length > 0) {
    limitations.push(`${input.skipped.length} changed file(s) were not analyzed (excluded or over limits).`);
  }
  if (input.scope.kind === 'pull-request' && input.checks.length === 0) {
    limitations.push('Pull request reviewed from the GitHub API; checks require the PR head checked out locally.');
  }
  if (byVerification['not-verified'] > 0) {
    limitations.push(`${byVerification['not-verified']} finding(s) could not be verified.`);
  }

  return { level, reasons, limitations, counts: { byVerification, bySeverity, checks, regressions } };
}
