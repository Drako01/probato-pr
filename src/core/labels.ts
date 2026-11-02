import { tr } from './i18n';
import type { Attribution, CheckResult, CheckStatus, CommandEvidence, Revision, RiskLevel, Severity, VerificationStatus } from './model';

// Single source for how domain states are named in the active locale: views, diagnostics and reports.

export function verificationLabel(status: VerificationStatus): string {
  switch (status) {
    case 'confirmed':
      return tr('Confirmed');
    case 'evidenced':
      return tr('Evidenced');
    case 'suspected':
      return tr('Suspected');
    case 'not-verified':
      return tr('Not verified');
  }
}

/** One-line meaning of each status, for legends and tooltips. */
export function verificationHint(status: VerificationStatus): string {
  switch (status) {
    case 'confirmed':
      return tr('Proven by an executed check');
    case 'evidenced':
      return tr('Backed by objective evidence in the code or a failing check');
    case 'suspected':
      return tr('Probable issue from heuristics or AI, not proven');
    case 'not-verified':
      return tr('The verification it needs could not be performed');
  }
}

export function checkStatusLabel(status: CheckStatus): string {
  switch (status) {
    case 'passed':
      return tr('Passed');
    case 'failed':
      return tr('Failed');
    case 'timed-out':
      return tr('Timed out');
    case 'cancelled':
      return tr('Cancelled');
    case 'error':
      return tr('Error');
    case 'pending':
      return tr('Not run');
  }
}

/** Undefined when nothing is known about causality. */
export function attributionLabel(attribution: Attribution | undefined): string | undefined {
  switch (attribution) {
    case 'introduced':
      return tr('Introduced by this change');
    case 'pre-existing':
      return tr('Pre-existing');
    case 'fixed':
      return tr('Fixed by this change');
    case 'inconclusive':
      return tr('Attribution inconclusive');
    case 'unknown':
    case undefined:
      return undefined;
  }
}

/** Check status plus its attribution, e.g. "Failed · Introduced by this change". */
export function checkResultLabel(check: CheckResult): string {
  return [checkStatusLabel(check.status), attributionLabel(check.attribution)].filter(Boolean).join(' · ');
}

/** Where a command ran, as a phrase: "with this change" or "on the base revision". */
export function revisionLabel(revision: Revision): string {
  return revision === 'base' ? tr('on the base revision') : tr('with this change');
}

/** Where a command ran, with its commit and whether the tree had uncommitted changes. */
export function evidenceRevisionLabel(evidence: Pick<CommandEvidence, 'revision' | 'commitSha' | 'dirty'>): string {
  const commit = evidence.commitSha ? ` (${evidence.commitSha.slice(0, 10)})` : '';
  return `${revisionLabel(evidence.revision)}${commit}${evidence.dirty ? ` ${tr('(with uncommitted changes)')}` : ''}`;
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return tr('Critical');
    case 'high':
      return tr('High');
    case 'medium':
      return tr('Medium');
    case 'low':
      return tr('Low');
  }
}

export function riskLabel(level: RiskLevel): string {
  return level === 'unknown' ? tr('Unknown') : severityLabel(level);
}
