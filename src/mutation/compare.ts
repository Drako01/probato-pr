import { tr } from '../core/i18n';
import type { MutationGatePolicy, MutationResult, MutationRunEvidence, MutationRecord } from './model';

const UNDETECTED = new Set(['SURVIVED', 'NO_COVERAGE']);
function invalid(run: MutationRunEvidence): boolean { return Boolean(run.error) || run.cancelled || run.timedOut || (run.exitCode !== 0 && !run.thresholdFailure) || !run.report || run.report.mutants.some((m) => ['TIMED_OUT', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'NOT_RUN'].includes(m.status)); }
function comparableReasons(head: MutationRunEvidence, base: MutationRunEvidence): string[] {
  const reasons: string[] = [];
  const h = head.reproducibility, b = base.reproducibility;
  if (!h || !b) reasons.push(tr('Mutation reproducibility metadata is missing.'));
  else {
    if (h.sourceHash !== b.sourceHash) reasons.push(tr('The mutated source differs between revisions; aggregate Mutation Scores are not equivalent.'));
    if (h.dependencyStatus === 'inconclusive' || b.dependencyStatus === 'inconclusive') reasons.push(tr('Installed mutation dependencies could not be matched to the reviewed lockfiles.'));
    if (h.dependencyHash !== b.dependencyHash) reasons.push(tr('Mutation dependencies differ between revisions.'));
    if (h.conditionsHash !== b.conditionsHash || h.configurationHash !== b.configurationHash || h.nodeVersion !== b.nodeVersion || h.strykerVersion !== b.strykerVersion || h.runner !== b.runner) reasons.push(tr('Mutation runner, configuration, runtime, or resource conditions differ between revisions.'));
  }
  if (invalid(head) || invalid(base)) reasons.push(tr('Mutation execution is incomplete or includes timeouts, execution errors, or unevaluated mutants.'));
  if (head.report && base.report) {
    const ids = (run: MutationRunEvidence) => JSON.stringify(run.report?.mutants.map((m) => m.identity).sort());
    if (ids(head) !== ids(base) || head.report.schemaVersion !== base.report.schemaVersion) reasons.push(tr('The mutation populations or report schemas are not equivalent.'));
  }
  return reasons;
}
export type MutationAssessment = Pick<MutationResult, 'verification' | 'baseline' | 'quality' | 'gate'> & { readonly head?: MutationRunEvidence };
/** Absolute and differential decisions remain separate; unavailable evidence never creates an artificial PASS. */
export function compareMutationRuns(head: MutationRunEvidence | undefined, base: MutationRunEvidence | undefined, policy: MutationGatePolicy, baselineRequested = true): MutationAssessment {
  const reasons = !base ? [tr('No measured mutation baseline is available.')] : !head ? [tr('No measured current mutation result is available.')] : comparableReasons(head, base);
  const comparable = Boolean(head && base && reasons.length === 0);
  const headScore = head?.report?.metrics.mutationScore, baseScore = base?.report?.metrics.mutationScore;
  const validHead = Boolean(head && !invalid(head) && headScore !== undefined);
  const delta = comparable && headScore !== undefined && baseScore !== undefined ? headScore - baseScore : undefined;
  const trend = delta === undefined ? baselineRequested ? 'INCONCLUSIVE' : 'NOT_APPLICABLE' : delta < -policy.tolerancePoints ? 'DEGRADED' : delta > policy.tolerancePoints ? 'IMPROVED' : 'UNCHANGED';
  const minimumBreached = validHead && (head?.thresholdFailure === true || (policy.minimumScore !== undefined && headScore !== undefined && headScore < policy.minimumScore));
  const degraded = trend === 'DEGRADED';
  const verification = !head ? 'SKIP' : head.cancelled || head.timedOut ? 'INCONCLUSIVE' : (head.exitCode !== 0 && !head.thresholdFailure) || head.error ? 'ERROR' : !validHead ? 'INCONCLUSIVE' : minimumBreached || (degraded && policy.failOnDegradation) ? 'FAIL' : baselineRequested && !comparable ? 'INCONCLUSIVE' : degraded || (head.report?.metrics.undetected ?? 0) > 0 ? 'WARN' : 'PASS';
  const gate = !policy.enabled ? 'SKIP' : !validHead ? 'INCONCLUSIVE' : minimumBreached || (degraded && policy.failOnDegradation) ? 'FAIL' : baselineRequested && !comparable ? 'INCONCLUSIVE' : degraded ? 'WARN' : baselineRequested && !comparable ? 'INCONCLUSIVE' : 'PASS';
  const qualityReasons = delta === undefined ? reasons : [tr('Mutation Score changed by {0} percentage points against the equivalent baseline.', Math.round(delta * 1_000_000) / 1_000_000)];
  const explainedHead = head && comparable && base?.report && head.report ? { ...head, report: { ...head.report, mutants: head.report.mutants.map((mutant): MutationRecord => {
    const previous = base.report?.mutants.find((candidate) => candidate.identity === mutant.identity);
    if (!previous) return { ...mutant, attribution: 'UNKNOWN' };
    if (previous.status === 'KILLED' && UNDETECTED.has(mutant.status)) return { ...mutant, attribution: 'INTRODUCED', reason: tr('The same mutant was killed in the baseline but is not detected by the current tests.') };
    if (UNDETECTED.has(previous.status) && mutant.status === 'KILLED') return { ...mutant, attribution: 'RESOLVED', reason: tr('The same surviving baseline mutant is killed by the current tests.') };
    if (UNDETECTED.has(previous.status) && UNDETECTED.has(mutant.status)) return { ...mutant, attribution: 'PERSISTENT', reason: tr('This undetected mutant already existed in the baseline; it is not a newly introduced regression.') };
    return { ...mutant, attribution: 'PRE_EXISTING' };
  }) } } : head;
  return {
    ...(explainedHead ? { head: explainedHead } : {}),
    verification: { status: verification, reasons: validHead ? (minimumBreached ? [tr('The measured Mutation Score is below the configured absolute minimum.')] : qualityReasons) : [head?.error ?? tr('Mutation verification lacks a complete valid report.')] },
    baseline: { status: !base ? 'MISSING' : comparable ? 'COMPARABLE' : 'NOT_COMPARABLE', reasons: comparable ? [tr('Mutated source, mutant population, dependencies, runner, and execution conditions are equivalent.')] : reasons },
    quality: { trend, metric: 'stryker-mutation-score', ...(delta !== undefined ? { deltaPoints: delta } : {}), reasons: qualityReasons },
    gate: { decision: gate, reasons: !policy.enabled ? [tr('The mutation quality gate is disabled.')] : minimumBreached ? [tr('The measured Mutation Score is below the configured absolute minimum.')] : qualityReasons },
  };
}
