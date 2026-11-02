import * as vscode from 'vscode';
import type { ReviewSession } from '../extension/review-session';
import { riskIcon, riskLabel, safeMarkdown } from './presentation';

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
    if (review) {
      const { risk } = review;
      const v = risk.counts.byVerification;
      const c = risk.counts.checks;
      nodes.push({
        id: 'risk',
        label: vscode.l10n.t('Review risk: {0}', riskLabel(risk.level).toUpperCase()),
        icon: riskIcon(risk.level),
        tooltip: [...risk.reasons, ...risk.limitations].join('\n'),
        children: [
          ...risk.reasons.map((r, i) => ({ id: `reason:${i}`, label: r, icon: new vscode.ThemeIcon('info'), tooltip: r })),
          { id: 'counts:findings', label: vscode.l10n.t('Confirmed {0} · Evidenced {1} · Suspected {2} · Not verified {3}', v.confirmed, v.evidenced, v.suspected, v['not-verified']), icon: new vscode.ThemeIcon('list-unordered') },
          { id: 'counts:checks', label: vscode.l10n.t('Checks passed {0} · failed {1} · not run {2}', c.passed, c.failed, c.notRun), icon: new vscode.ThemeIcon('beaker') },
          ...(this.session.dismissedCount() > 0
            ? [{ id: 'dismissed', label: vscode.l10n.t('{0} dismissed finding(s) hidden', this.session.dismissedCount()), icon: new vscode.ThemeIcon('eye-closed'), command: { command: 'probatoPR.restoreDismissed', title: '' } }]
            : []),
          ...risk.limitations.map((l, i) => ({ id: `limit:${i}`, label: l, icon: new vscode.ThemeIcon('warning'), tooltip: l })),
        ],
      });
      nodes.push({
        id: 'repo',
        label: review.repository.name,
        description: [review.repository.branch, review.scope.label].filter(Boolean).join(' · '),
        icon: new vscode.ThemeIcon('repo'),
        tooltip: `${review.scope.label}\n${vscode.l10n.t('{0} files changed (+{1} / -{2}), {3} skipped', review.stats.filesChanged, review.stats.additions, review.stats.deletions, review.stats.filesSkipped)}`,
      });
    }
    nodes.push({
      id: 'review',
      label: vscode.l10n.t('Review'),
      icon: new vscode.ThemeIcon('git-compare'),
      children: [
        action('current', vscode.l10n.t('Current Changes'), 'probatoPR.reviewCurrentChanges', 'diff'),
        action('staged', vscode.l10n.t('Staged Changes'), 'probatoPR.reviewStagedChanges', 'diff-added'),
        action('branch', vscode.l10n.t('Branch Changes'), 'probatoPR.reviewBranch', 'git-branch'),
        action('commit', vscode.l10n.t('Commit'), 'probatoPR.reviewCommit', 'git-commit'),
        action('pr', vscode.l10n.t('Pull Request'), 'probatoPR.reviewPullRequest', 'git-pull-request'),
      ],
    });
    if (review) {
      nodes.push({
        id: 'reports',
        label: vscode.l10n.t('Reports'),
        icon: new vscode.ThemeIcon('output'),
        children: [action('show', vscode.l10n.t('Show Review Results'), 'probatoPR.showResults', 'preview'), action('export', vscode.l10n.t('Export Report…'), 'probatoPR.exportReport', 'export')],
      });
    }
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? (node.id === 'review' || node.id === 'risk' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
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
