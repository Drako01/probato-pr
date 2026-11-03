import * as vscode from 'vscode';
import type { CheckStatus, ReviewFinding, ReviewResult, RiskLevel, Severity } from '../core/model';
import type { StepState } from './workflow';

// Single source for how domain states look in the UI (icons, Markdown); their names live in core/labels.

export {
  attributionLabel,
  checkKindLabel,
  checkResultLabel,
  checkStatusLabel,
  evidenceRevisionLabel,
  revisionLabel,
  riskLabel,
  severityLabel,
  verificationHint,
  verificationLabel,
} from '../core/labels';

/** "branch · scope" line that identifies a review. */
export function reviewSubtitle(review: ReviewResult): string {
  return [review.repository.branch, review.scope.label].filter(Boolean).join(' · ');
}

export function reviewStatsLabel({ stats }: ReviewResult): string {
  return vscode.l10n.t('{0} files changed (+{1} / -{2}), {3} skipped', stats.filesChanged, stats.additions, stats.deletions, stats.filesSkipped);
}

const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  critical: 'errorForeground',
  high: 'problemsErrorIcon.foreground',
  medium: 'problemsWarningIcon.foreground',
  low: 'problemsInfoIcon.foreground',
};

export function severityIcon(severity: Severity): vscode.ThemeIcon {
  const icon = severity === 'critical' || severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'info';
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(SEVERITY_COLOR[severity]));
}

/** Icon shape encodes verification strength so it is distinguishable without color. */
export function verificationIcon(finding: ReviewFinding): vscode.ThemeIcon {
  const color = new vscode.ThemeColor(SEVERITY_COLOR[finding.severity]);
  switch (finding.verification) {
    case 'confirmed':
      return new vscode.ThemeIcon('verified-filled', color);
    case 'evidenced':
      return new vscode.ThemeIcon('pass', color);
    case 'suspected':
      return new vscode.ThemeIcon('question', color);
    case 'not-verified':
      return new vscode.ThemeIcon('circle-slash', color);
  }
}

export function checkIcon(status: CheckStatus): vscode.ThemeIcon {
  switch (status) {
    case 'passed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'timed-out':
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('testing.iconErrored'));
    case 'cancelled':
      return new vscode.ThemeIcon('debug-stop');
    case 'error':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconErrored'));
    case 'pending':
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function stepIcon(state: StepState): vscode.ThemeIcon {
  switch (state) {
    case 'done':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'current':
      return new vscode.ThemeIcon('arrow-circle-right', new vscode.ThemeColor('textLink.foreground'));
    case 'todo':
      return new vscode.ThemeIcon('circle-large-outline');
    case 'unavailable':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  }
}

export function riskIcon(level: RiskLevel): vscode.ThemeIcon {
  return level === 'unknown' || level === 'low' ? new vscode.ThemeIcon('shield') : severityIcon(level);
}

/** Markdown hover that never trusts repository-derived text (no command links, HTML disabled). */
export function safeMarkdown(...paragraphs: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, false);
  md.isTrusted = false;
  md.supportHtml = false;
  paragraphs.forEach((p, i) => {
    if (i > 0) {
      md.appendMarkdown('\n\n');
    }
    md.appendText(p);
  });
  return md;
}
