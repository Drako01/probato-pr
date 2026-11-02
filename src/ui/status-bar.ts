import * as vscode from 'vscode';
import type { RiskLevel } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { riskLabel } from './presentation';
import { workflowSteps } from './summary-view-model';

const PRIORITY = 50;

/** Only risks that need attention get a colored background (the status bar has error and warning colors only). */
const RISK_BACKGROUND: Readonly<Partial<Record<RiskLevel, string>>> = {
  critical: 'statusBarItem.errorBackground',
  high: 'statusBarItem.warningBackground',
};

/** Persistent status bar entry: the running operation (click cancels) or the current review risk (click opens the summary). */
export class ReviewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('probatoPR.status', vscode.StatusBarAlignment.Left, PRIORITY);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: ReviewSession) {
    this.item.name = 'Probato PR';
    this.subscription = session.onDidChange(() => {
      this.refresh();
    });
    this.refresh();
  }

  private refresh(): void {
    const busy = this.session.busyLabel;
    const review = this.session.current;
    this.item.backgroundColor = undefined;
    if (busy) {
      this.item.text = `$(loading~spin) ${busy}…`;
      this.item.tooltip = vscode.l10n.t('Click to cancel');
      this.item.command = 'probatoPR.cancel';
      this.item.show();
      return;
    }
    if (!review) {
      this.item.hide();
      return;
    }
    const count = this.session.visibleFindings().length;
    const level = review.risk.level;
    this.item.text = `$(shield) ${riskLabel(level).toUpperCase()} · ${count}`;
    const background = RISK_BACKGROUND[level];
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    const next = workflowSteps(this.session).find((step) => step.state === 'current');
    const tooltip = new vscode.MarkdownString(undefined, false);
    tooltip.appendText(`Probato PR · ${vscode.l10n.t('Review risk: {0}', riskLabel(level).toUpperCase())} · ${vscode.l10n.t('{0} finding(s)', count)}`);
    if (next) {
      tooltip.appendMarkdown('\n\n');
      tooltip.appendText(`${vscode.l10n.t('Next step')}: ${next.title} — ${next.detail}`);
    }
    this.item.tooltip = tooltip;
    this.item.command = 'probatoPR.showResults';
    this.item.accessibilityInformation = { label: vscode.l10n.t('Probato PR review risk {0}, {1} finding(s). Open the review summary.', riskLabel(level), count) };
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
