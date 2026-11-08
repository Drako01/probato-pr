// CLI/CI quality gate. Pure domain: decides an exit code from a finished review and an explicit policy.
//
// Exit contract (all modes): 0 = accepted by the policy (PASS, or WARN when the policy allows it);
// 1 = demonstrated quality failure; 2 = execution error or incompleteness the policy blocks.
// `absolute` reproduces the 0.6.0 behavior exactly and stays the default.
import { tr } from './i18n';
import { SEVERITIES, type ReviewFinding, type ReviewResult, type Severity } from './model';

export const GATE_MODES = ['absolute', 'regression-only', 'hybrid'] as const;
export type GateMode = (typeof GATE_MODES)[number];
export const INCONCLUSIVE_POLICIES = ['fail', 'warn'] as const;
export type InconclusivePolicy = (typeof INCONCLUSIVE_POLICIES)[number];

export interface GatePolicy {
  readonly mode: GateMode;
  readonly threshold: Severity | 'none';
  /** What a failed check without comparable baseline attribution means in the differential modes. */
  readonly inconclusive: InconclusivePolicy;
}

export type GateOutcome = 'PASS' | 'WARN' | 'FAIL' | 'INCOMPLETE';

export interface GateDecision {
  readonly mode: GateMode;
  readonly outcome: GateOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly reasons: readonly string[];
}

const DEMONSTRATED = new Set<ReviewFinding['verification']>(['confirmed', 'evidenced']);

function executionIncomplete(review: ReviewResult): boolean {
  if (review.analyzerRuns.some((run) => run.status === 'failed')) return true;
  if (review.checks.some((check) => check.status === 'error' || check.status === 'timed-out' || check.status === 'cancelled' || check.status === 'pending')) return true;
  const mutation = review.mutation;
  return Boolean(mutation && (mutation.execution.status !== 'COMPLETED' || mutation.verification.status === 'ERROR' || mutation.verification.status === 'INCONCLUSIVE' || mutation.head?.timedOut || mutation.base?.timedOut || (mutation.policy.enabled && mutation.gate.decision === 'INCONCLUSIVE')));
}

function meetsThreshold(finding: ReviewFinding, threshold: Severity | 'none'): boolean {
  return threshold !== 'none' && SEVERITIES.indexOf(finding.severity) <= SEVERITIES.indexOf(threshold);
}

/** Whether a finding at the threshold blocks, only warns, or is outside the gate for the given mode. */
function findingEffect(finding: ReviewFinding, mode: GateMode): 'block' | 'warn' | 'ignore' {
  if (mode === 'absolute') return 'block';
  const attribution = finding.attribution ?? 'unknown';
  if (attribution === 'pre-existing' || attribution === 'fixed') return 'ignore';
  // Heuristic or AI findings ("suspected") and unverifiable ones never block a differential gate on their own.
  if (!DEMONSTRATED.has(finding.verification)) return 'warn';
  if (mode === 'regression-only') return attribution === 'introduced' ? 'block' : 'warn';
  return 'block';
}

export function evaluateQualityGate(review: ReviewResult, policy: GatePolicy): GateDecision {
  const { mode } = policy;
  const decide = (outcome: GateOutcome, exitCode: 0 | 1 | 2, reasons: readonly string[]): GateDecision => ({ mode, outcome, exitCode, reasons });
  // Incomplete execution takes precedence over a simultaneous demonstrated quality failure.
  if (executionIncomplete(review)) return decide('INCOMPLETE', 2, [tr('Analysis, checks or requested mutation testing did not complete.')]);

  const failures: string[] = [], warnings: string[] = [], inconclusive: string[] = [];
  if (review.mutation?.gate.decision === 'FAIL') failures.push(tr('The mutation quality gate failed.'));
  for (const check of review.checks.filter((c) => c.status === 'failed')) {
    const attribution = check.attribution;
    if (mode === 'absolute' || attribution === 'introduced') failures.push(tr('Check {0} failed ({1}).', check.label, attribution));
    else if (attribution === 'pre-existing' || attribution === 'fixed') warnings.push(tr('Check {0} also fails on the base revision; not a regression.', check.label));
    else inconclusive.push(tr('Check {0} failed without comparable baseline evidence.', check.label));
  }
  const atThreshold = review.findings.filter((finding) => meetsThreshold(finding, policy.threshold));
  const blocking = atThreshold.filter((finding) => findingEffect(finding, mode) === 'block');
  const warned = atThreshold.filter((finding) => findingEffect(finding, mode) === 'warn');
  if (blocking.length) failures.push(tr('{0} finding(s) meet the {1} threshold.', blocking.length, policy.threshold));
  if (warned.length) warnings.push(tr('{0} finding(s) meet the threshold but are not demonstrated regressions.', warned.length));

  // A demonstrated failure outranks missing attribution: it is already proven.
  if (failures.length) return decide('FAIL', 1, [...failures, ...inconclusive, ...warnings]);
  if (inconclusive.length && policy.inconclusive === 'fail') return decide('INCOMPLETE', 2, [...inconclusive, ...warnings]);
  if (inconclusive.length || warnings.length) return decide('WARN', 0, [...inconclusive, ...warnings]);
  return decide('PASS', 0, []);
}
