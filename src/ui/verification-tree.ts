import * as vscode from 'vscode';
import type { CheckResult, CommandEvidence, PlannedCheck } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { checkIcon, safeMarkdown } from './presentation';

type Node =
  | { readonly kind: 'section'; readonly id: string; readonly label: string; readonly children: readonly Node[] }
  | { readonly kind: 'check'; readonly check: CheckResult }
  | { readonly kind: 'planned'; readonly check: PlannedCheck }
  | { readonly kind: 'evidence'; readonly evidence: CommandEvidence }
  | { readonly kind: 'hint'; readonly label: string; readonly command?: vscode.Command };

/** Planned checks, executed checks with attribution, and the raw command evidence behind them. */
export class VerificationTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
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
      return node.kind === 'section' ? [...node.children] : [];
    }
    const review = this.session.current;
    if (!review) {
      return [];
    }
    const sections: Node[] = [];
    if (review.checks.length > 0) {
      sections.push({ kind: 'section', id: 'executed', label: vscode.l10n.t('Executed Checks'), children: review.checks.map((check) => ({ kind: 'check' as const, check })) });
      const evidence = review.evidence.filter((e): e is CommandEvidence => e.kind === 'command-run');
      sections.push({ kind: 'section', id: 'evidence', label: vscode.l10n.t('Evidence'), children: evidence.map((e) => ({ kind: 'evidence' as const, evidence: e })) });
    } else if (this.session.plan.length > 0) {
      sections.push({ kind: 'section', id: 'available', label: vscode.l10n.t('Available Checks'), children: this.session.plan.map((check) => ({ kind: 'planned' as const, check })) });
    } else {
      sections.push({ kind: 'hint', label: vscode.l10n.t('Run verification to execute project checks with evidence'), command: { command: 'probatoPR.verify', title: '' } });
    }
    return sections;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(`${node.label} (${node.children.length})`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon('beaker');
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
      case 'planned': {
        const item = new vscode.TreeItem(node.check.label);
        item.iconPath = new vscode.ThemeIcon('circle-outline');
        item.description = node.check.kind;
        item.tooltip = safeMarkdown(node.check.rationale, ...node.check.warnings, ...node.check.requires.map((r) => vscode.l10n.t('May require: {0}', r)));
        return item;
      }
      case 'check': {
        const c = node.check;
        const item = new vscode.TreeItem(c.label);
        item.id = `check:${c.checkId}`;
        item.iconPath = checkIcon(c.status);
        item.description = c.attribution === 'unknown' ? c.status : `${c.status} · ${c.attribution}`;
        item.tooltip = safeMarkdown(c.commandLine, c.attributionNote);
        item.accessibilityInformation = { label: `${c.label}: ${c.status}. ${c.attributionNote}` };
        if (c.headEvidenceId) {
          item.command = { command: 'probatoPR.openEvidence', title: vscode.l10n.t('Open Evidence'), arguments: [c.headEvidenceId] };
        }
        return item;
      }
      case 'evidence': {
        const e = node.evidence;
        const item = new vscode.TreeItem(`${e.revision === 'base' ? vscode.l10n.t('base') : vscode.l10n.t('head')} · ${e.commandLine}`);
        item.id = `evidence:${e.id}`;
        item.iconPath = checkIcon(e.outcome);
        item.description = `exit ${String(e.exitCode)} · ${(e.durationMs / 1000).toFixed(1)}s`;
        item.command = { command: 'probatoPR.openEvidence', title: vscode.l10n.t('Open Evidence'), arguments: [e.id] };
        return item;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
