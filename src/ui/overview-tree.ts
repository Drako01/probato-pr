import * as vscode from 'vscode';
import { VERIFICATION_STATUSES } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { reviewStatsLabel, reviewSubtitle, riskIcon, riskLabel, safeMarkdown, stepIcon, verificationHint, verificationLabel } from './presentation';
import { SUMMARY_COMMAND_IDS } from './summary-protocol';
import { workflowSteps } from './summary-view-model';

interface Node {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: vscode.ThemeIcon;
  readonly tooltip?: string;
  readonly command?: vscode.Command;
  readonly children?: readonly Node[];
}

const action = (id: string, label: string, command: string, icon: string): Node => ({
  id: `action:${id}`,
  label,
  icon: new vscode.ThemeIcon(icon),
  command: { command, title: label },
});

/** Repository context, risk summary with its reasons and limitations, and review entry points. */
export class OverviewTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: ReviewSession) {
    this.subscription = session.onDidChange(() => {
      this.emitter.fire(undefined);
    });
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [...(node.children ?? [])];
    }
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
      return []; // welcome content explains what to do
    }
    const nodes: Node[] = [];
    const busy = this.session.busyLabel;
    if (busy) {
      nodes.push({ id: 'busy', label: busy, icon: new vscode.ThemeIcon('loading~spin'), command: { command: 'probatoPR.cancel', title: vscode.l10n.t('Cancel') }, description: vscode.l10n.t('click to cancel') });
    }
    const review = this.session.current;
    if (!review) {
      return nodes; // empty: the welcome view presents the three steps and the review buttons
    }
    const { risk } = review;
    const v = risk.counts.byVerification;
    nodes.push({
      id: 'risk',
      label: vscode.l10n.t('Review risk: {0}', riskLabel(risk.level).toUpperCase()),
      description: vscode.l10n.t('{0} finding(s)', this.session.visibleFindings().length),
      icon: riskIcon(risk.level),
      tooltip: [...risk.reasons, ...risk.limitations].join('\n'),
      command: { command: 'probatoPR.showResults', title: vscode.l10n.t('Show Review Results') },
      children: [
        ...risk.reasons.map((r, i) => ({ id: `reason:${i}`, label: r, icon: new vscode.ThemeIcon('info'), tooltip: r })),
        {
          id: 'counts:findings',
          label: vscode.l10n.t('Confirmed {0} · Evidenced {1} · Suspected {2} · Not verified {3}', v.confirmed, v.evidenced, v.suspected, v['not-verified']),
          icon: new vscode.ThemeIcon('list-unordered'),
          tooltip: VERIFICATION_STATUSES.map((s) => `${verificationLabel(s)}: ${verificationHint(s)}`).join('\n'),
        },
        ...(this.session.dismissedCount() > 0
          ? [{ id: 'dismissed', label: vscode.l10n.t('{0} dismissed finding(s) hidden', this.session.dismissedCount()), icon: new vscode.ThemeIcon('eye-closed'), command: { command: 'probatoPR.restoreDismissed', title: '' } }]
          : []),
        ...risk.limitations.map((l, i) => ({ id: `limit:${i}`, label: l, icon: new vscode.ThemeIcon('warning'), tooltip: l })),
      ],
    });
    workflowSteps(this.session).forEach((step, index) => {
      nodes.push({
        id: `step:${step.id}`,
        label: `${index + 1}. ${step.title}`,
        description: step.detail,
        tooltip: step.detail,
        icon: stepIcon(step.state),
        ...(step.action && step.state !== 'done' ? { command: { command: SUMMARY_COMMAND_IDS[step.action.command], title: step.action.label } } : {}),
        // Step 1 offers the other review scopes; a finished review can be re-run from here.
        ...(step.id === 'review'
          ? {
              children: [
                action('current', vscode.l10n.t('Current Changes'), 'probatoPR.reviewCurrentChanges', 'diff'),
                action('staged', vscode.l10n.t('Staged Changes'), 'probatoPR.reviewStagedChanges', 'diff-added'),
                action('branch', vscode.l10n.t('Branch Changes'), 'probatoPR.reviewBranch', 'git-branch'),
                action('commit', vscode.l10n.t('Commit'), 'probatoPR.reviewCommit', 'git-commit'),
                action('pr', vscode.l10n.t('Pull Request'), 'probatoPR.reviewPullRequest', 'git-pull-request'),
              ],
            }
          : {}),
        ...(step.id === 'share'
          ? {
              children: [
                action('show', vscode.l10n.t('Show Review Results'), 'probatoPR.showResults', 'preview'),
                action('export', vscode.l10n.t('Export Report…'), 'probatoPR.exportReport', 'export'),
                action('markdown', vscode.l10n.t('Markdown for the PR description'), 'probatoPR.openMarkdownReport', 'markdown'),
                action('ai', vscode.l10n.t('AI Review (Optional)'), 'probatoPR.aiReview', 'sparkle'),
              ],
            }
          : {}),
      });
    });
    nodes.push({
      id: 'repo',
      label: review.repository.name,
      description: reviewSubtitle(review),
      icon: new vscode.ThemeIcon('repo'),
      tooltip: `${review.scope.label}\n${reviewStatsLabel(review)}`,
    });
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? (node.id === 'risk' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (node.description !== undefined) {
      item.description = node.description;
    }
    if (node.icon) {
      item.iconPath = node.icon;
    }
    if (node.tooltip) {
      item.tooltip = safeMarkdown(node.tooltip);
    }
    if (node.command) {
      item.command = node.command;
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
