import { tr } from './i18n';
import type { ReviewFinding, ReviewResult } from './model';

export type ComparisonStatus = 'new' | 'persisting' | 'no-longer-observed';
export interface ComparisonEntry {
  readonly status: ComparisonStatus;
  readonly current?: ReviewFinding;
  readonly previous?: ReviewFinding;
  readonly note: string;
  /** A formerly failing, explicitly linked check now passes. This is not a proof of finding resolution. */
  readonly passedCheckEvidenceId?: string;
}
export interface ReviewComparison {
  readonly comparable: boolean;
  readonly reason?: string;
  readonly previousId: string;
  readonly currentId: string;
  readonly entries: readonly ComparisonEntry[];
  readonly counts: Readonly<Record<ComparisonStatus, number>>;
}

function repositoryIdentity(review: ReviewResult): string | undefined {
  const root = review.repository.root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) return /^[a-z]:\//i.test(root) ? root.toLowerCase() : root;
  const pr = review.scope.pullRequest;
  return pr ? `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}` : undefined;
}

/** A changed base, repository, branch or review scope makes lifecycle labels misleading, so comparison fails closed. */
export function comparisonBlocker(previous: ReviewResult, current: ReviewResult): string | undefined {
  const repository = repositoryIdentity(previous);
  if (!repository || repository !== repositoryIdentity(current)) return tr('These reviews belong to different repositories or their repository identity is unavailable.');
  if (previous.id === current.id) return tr('Choose a different review to compare.');
  if (previous.scope.kind !== current.scope.kind) return tr('These reviews inspect different change scopes.');
  if (!previous.scope.baseSha || !current.scope.baseSha || previous.scope.baseSha !== current.scope.baseSha) return tr('The reviews do not share a known, identical base commit. Run comparable reviews before comparing findings.');
  const previousPr = previous.scope.pullRequest;
  const currentPr = current.scope.pullRequest;
  if (Boolean(previousPr) !== Boolean(currentPr) || (previousPr && currentPr && (previousPr.owner.toLowerCase() !== currentPr.owner.toLowerCase() || previousPr.repo.toLowerCase() !== currentPr.repo.toLowerCase() || previousPr.number !== currentPr.number))) return tr('These reviews refer to different pull requests.');
  if (previous.repository.branch !== current.repository.branch || previous.scope.headRef !== current.scope.headRef) return tr('These reviews refer to different branches or revision targets.');
  return undefined;
}

function semanticKey(finding: ReviewFinding): string {
  return JSON.stringify([finding.ruleId, finding.location.file, finding.title]);
}

function nowPassingEvidence(previous: ReviewResult, current: ReviewResult, finding: ReviewFinding): string | undefined {
  const referenced = new Set(finding.evidence.map((reference) => reference.evidenceId));
  for (const oldCheck of previous.checks) {
    if (!oldCheck.headEvidenceId || !referenced.has(oldCheck.headEvidenceId) || oldCheck.status !== 'failed') continue;
    const check = current.checks.find((candidate) => candidate.checkId === oldCheck.checkId && candidate.commandLine === oldCheck.commandLine && candidate.status === 'passed');
    const evidence = check?.headEvidenceId ? current.evidence.find((candidate) => candidate.id === check.headEvidenceId) : undefined;
    if (evidence?.kind === 'command-run' && evidence.revision === 'head' && evidence.outcome === 'passed' && evidence.exitCode === 0 && !evidence.outputTruncated) return evidence.id;
  }
  return undefined;
}

/** Finding lifecycle comparison is observational; disappearance is never silently promoted to resolution. */
export function compareReviews(previous: ReviewResult, current: ReviewResult): ReviewComparison {
  const reason = comparisonBlocker(previous, current);
  const counts: Record<ComparisonStatus, number> = { new: 0, persisting: 0, 'no-longer-observed': 0 };
  if (reason) return { comparable: false, reason, previousId: previous.id, currentId: current.id, entries: [], counts };
  const remaining = [...previous.findings];
  const entries: ComparisonEntry[] = [];
  for (const finding of current.findings) {
    let index = remaining.findIndex((candidate) => candidate.id === finding.id && candidate.ruleId === finding.ruleId && candidate.location.file === finding.location.file);
    if (index < 0) index = remaining.findIndex((candidate) => semanticKey(candidate) === semanticKey(finding));
    const prior = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    const status = prior ? 'persisting' : 'new';
    counts[status]++;
    entries.push({ status, current: finding, ...(prior ? { previous: prior } : {}), note: prior ? tr('Observed in both reviews. Verification and attribution still depend on the current evidence.') : tr('Newly observed in this review. This does not by itself establish when the defect was introduced.') });
  }
  for (const finding of remaining) {
    const passedCheckEvidenceId = nowPassingEvidence(previous, current, finding);
    counts['no-longer-observed']++;
    entries.push({ status: 'no-longer-observed', previous: finding, ...(passedCheckEvidenceId ? { passedCheckEvidenceId } : {}), note: passedCheckEvidenceId
      ? tr('No longer observed. A previously linked check now passes, but this alone does not prove that the finding is resolved.')
      : tr('No longer observed, without proof of resolution. The analyzer may have skipped the code or produced a different result.') });
  }
  return { comparable: true, previousId: previous.id, currentId: current.id, entries, counts };
}
