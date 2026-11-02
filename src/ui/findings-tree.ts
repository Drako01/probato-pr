import * as vscode from 'vscode';
import { SEVERITIES, type ReviewFinding, type Severity } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { safeMarkdown, severityIcon, severityLabel, verificationIcon, verificationLabel } from './presentation';

type Node = { readonly kind: 'group'; readonly severity: Severity; readonly findings: readonly ReviewFinding[] } | { readonly kind: 'finding'; readonly finding: ReviewFinding };

export class FindingsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: ReviewSession) {
    this.subscription = session.onDidChange(() => {
      this.emitter.fire(undefined);
    });
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const findings = this.session.visibleFindings();
      return SEVERITIES.map((severity) => ({ kind: 'group' as const, severity, findings: findings.filter((f) => f.severity === severity) })).filter(
        (g) => g.findings.length > 0,
      );
    }
    return node.kind === 'group' ? node.findings.map((finding) => ({ kind: 'finding' as const, finding })) : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(`${severityLabel(node.severity)} (${node.findings.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = severityIcon(node.severity);
      item.id = `group:${node.severity}`;
      return item;
    }
    const f = node.finding;
    const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
    item.id = `finding:${f.id}`;
    item.description = `${verificationLabel(f.verification)} · ${f.location.file}:${f.location.startLine}`;
    item.iconPath = verificationIcon(f);
    item.contextValue = 'probatoFinding';
    item.accessibilityInformation = {
      label: vscode.l10n.t('{0} severity, {1}: {2} at {3} line {4}', severityLabel(f.severity), verificationLabel(f.verification), f.title, f.location.file, f.location.startLine),
    };
    item.tooltip = safeMarkdown(
      f.title,
      `${severityLabel(f.severity)} · ${verificationLabel(f.verification)}${f.attribution && f.attribution !== 'unknown' ? ` · ${f.attribution}` : ''}`,
      f.description,
      `${vscode.l10n.t('Why this status')}: ${f.verificationNote}`,
      ...(f.suggestedFix ? [`${vscode.l10n.t('Suggested fix')}: ${f.suggestedFix}`] : []),
      `${f.ruleId} · ${f.location.file}:${f.location.startLine}`,
    );
    item.command = { command: 'probatoPR.openFinding', title: vscode.l10n.t('Open'), arguments: [f.id] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
