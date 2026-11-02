import * as path from 'node:path';
import * as vscode from 'vscode';
import { SEVERITIES, type ReviewFinding, type Severity } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { attributionLabel, safeMarkdown, severityIcon, severityLabel, verificationIcon, verificationLabel } from './presentation';

export type FindingsGrouping = 'severity' | 'file';

const GROUPING_KEY = 'probatoPR.findingsGrouping';

type Node =
  | { readonly kind: 'severity'; readonly severity: Severity; readonly findings: readonly ReviewFinding[] }
  | { readonly kind: 'file'; readonly file: string; readonly findings: readonly ReviewFinding[] }
  | { readonly kind: 'finding'; readonly finding: ReviewFinding; readonly showFile: boolean };

const bySeverity = (a: ReviewFinding, b: ReviewFinding): number => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

class FindingsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly session: ReviewSession,
    private grouping: FindingsGrouping,
  ) {}

  setGrouping(grouping: FindingsGrouping): void {
    this.grouping = grouping;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return node.kind === 'finding' ? [] : node.findings.map((finding) => ({ kind: 'finding' as const, finding, showFile: node.kind === 'severity' }));
    }
    const findings = this.session.visibleFindings();
    if (this.grouping === 'file') {
      const files = [...new Set(findings.map((f) => f.location.file))].sort((a, b) => a.localeCompare(b));
      return files.map((file) => ({ kind: 'file' as const, file, findings: findings.filter((f) => f.location.file === file).sort(bySeverity) }));
    }
    return SEVERITIES.map((severity) => ({ kind: 'severity' as const, severity, findings: findings.filter((f) => f.severity === severity) })).filter((g) => g.findings.length > 0);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'severity': {
        const item = new vscode.TreeItem(severityLabel(node.severity), vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.findings.length);
        item.iconPath = severityIcon(node.severity);
        item.id = `group:${node.severity}`;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(path.posix.basename(node.file), vscode.TreeItemCollapsibleState.Expanded);
        const dir = path.posix.dirname(node.file);
        item.description = `${dir === '.' ? '' : `${dir} · `}${node.findings.length}`;
        // A resource URI gives the file-type icon from the icon theme (and Git/problem decorations when local).
        const root = this.session.current?.repository.root;
        item.resourceUri = root ? vscode.Uri.file(path.join(root, ...node.file.split('/'))) : vscode.Uri.file(`/${node.file}`);
        item.iconPath = vscode.ThemeIcon.File;
        item.id = `file:${node.file}`;
        item.tooltip = node.file;
        return item;
      }
      case 'finding':
        return this.findingItem(node.finding, node.showFile);
    }
  }

  private findingItem(f: ReviewFinding, showFile: boolean): vscode.TreeItem {
    const item = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
    item.id = `finding:${f.id}`;
    const where = showFile ? `${f.location.file}:${f.location.startLine}` : vscode.l10n.t('line {0}', f.location.startLine);
    item.description = `${verificationLabel(f.verification)} · ${where}`;
    item.iconPath = verificationIcon(f);
    item.contextValue = 'probatoFinding';
    item.accessibilityInformation = {
      label: vscode.l10n.t('{0} severity, {1}: {2} at {3} line {4}', severityLabel(f.severity), verificationLabel(f.verification), f.title, f.location.file, f.location.startLine),
    };
    const attribution = attributionLabel(f.attribution);
    item.tooltip = safeMarkdown(
      f.title,
      [severityLabel(f.severity), verificationLabel(f.verification), attribution].filter(Boolean).join(' · '),
      f.description,
      `${vscode.l10n.t('Why this status')}: ${f.verificationNote}`,
      ...(f.suggestedFix ? [`${vscode.l10n.t('Suggested fix')}: ${f.suggestedFix}`] : []),
      `${f.ruleId} · ${f.location.file}:${f.location.startLine}`,
    );
    item.command = { command: 'probatoPR.openFinding', title: vscode.l10n.t('Open'), arguments: [f.id] };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/**
 * The Findings view: grouped by severity or by file (remembered per workspace), with a count badge on the
 * Probato PR activity bar icon and a `probatoPR.visibleFindings` context key for the empty-state welcome.
 */
export function createFindingsView(session: ReviewSession, memento: vscode.Memento): vscode.Disposable {
  const initial = memento.get<FindingsGrouping>(GROUPING_KEY, 'severity');
  const provider = new FindingsTreeProvider(session, initial);
  const view = vscode.window.createTreeView('probatoPR.findings', { treeDataProvider: provider, showCollapseAll: true });

  const setGrouping = async (grouping: FindingsGrouping): Promise<void> => {
    provider.setGrouping(grouping);
    await vscode.commands.executeCommand('setContext', 'probatoPR.findingsGrouping', grouping);
    await memento.update(GROUPING_KEY, grouping);
  };

  const sync = (): void => {
    provider.refresh();
    const count = session.visibleFindings().length;
    view.badge = count > 0 ? { value: count, tooltip: vscode.l10n.t('{0} finding(s)', count) } : undefined;
    void vscode.commands.executeCommand('setContext', 'probatoPR.visibleFindings', count);
  };

  void vscode.commands.executeCommand('setContext', 'probatoPR.findingsGrouping', initial);
  sync();
  return vscode.Disposable.from(
    view,
    provider,
    session.onDidChange(sync),
    vscode.commands.registerCommand('probatoPR.groupFindingsByFile', () => setGrouping('file')),
    vscode.commands.registerCommand('probatoPR.groupFindingsBySeverity', () => setGrouping('severity')),
  );
}
