import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFinding } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { verificationLabel } from './presentation';

const SOURCE = 'Probato PR';

function severityOf(f: ReviewFinding): vscode.DiagnosticSeverity {
  const backed = f.verification === 'confirmed' || f.verification === 'evidenced';
  if ((f.severity === 'critical' || f.severity === 'high') && backed) {
    return vscode.DiagnosticSeverity.Error;
  }
  return f.severity === 'low' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
}

/** Diagnostics reach code action providers as copies, so findings are matched by file, line and message. */
function diagnosticKey(uri: vscode.Uri, diagnostic: vscode.Diagnostic): string {
  return `${uri.toString()}#${diagnostic.range.start.line}#${diagnostic.message}`;
}

/** Publishes visible findings as editor diagnostics (Problems panel + squiggles) through the official API. */
export class FindingDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('probato-pr');
  private readonly subscription: vscode.Disposable;
  private findingsByDiagnostic = new Map<string, ReviewFinding>();

  constructor(private readonly session: ReviewSession) {
    this.subscription = session.onDidChange(() => {
      this.refresh();
    });
  }

  /** The finding behind one of our diagnostics, if it is still visible. */
  findingFor(uri: vscode.Uri, diagnostic: vscode.Diagnostic): ReviewFinding | undefined {
    return diagnostic.source === SOURCE ? this.findingsByDiagnostic.get(diagnosticKey(uri, diagnostic)) : undefined;
  }

  private refresh(): void {
    this.collection.clear();
    this.findingsByDiagnostic = new Map();
    const review = this.session.current;
    if (!review?.repository.root) {
      return; // remote-only (PR via API) reviews have no local files to annotate
    }
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const finding of this.session.visibleFindings()) {
      const line = Math.max(0, finding.location.startLine - 1);
      const endLine = Math.max(line, (finding.location.endLine ?? finding.location.startLine) - 1);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, endLine, Number.MAX_SAFE_INTEGER),
        `[${verificationLabel(finding.verification)}] ${finding.title} — ${finding.verificationNote}`,
        severityOf(finding),
      );
      diagnostic.source = SOURCE;
      diagnostic.code = finding.ruleId;
      const uri = vscode.Uri.file(path.join(review.repository.root, ...finding.location.file.split('/')));
      this.findingsByDiagnostic.set(diagnosticKey(uri, diagnostic), finding);
      const list = byFile.get(uri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(uri.toString(), list);
    }
    for (const [uri, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}

/** Light-bulb actions on Probato PR diagnostics: dismiss the finding, open its evidence, or open the summary. */
export class FindingCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly diagnostics: FindingDiagnostics) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    return context.diagnostics.flatMap((diagnostic) => {
      const finding = this.diagnostics.findingFor(document.uri, diagnostic);
      if (!finding) {
        return [];
      }
      const action = (title: string, command: vscode.Command): vscode.CodeAction => {
        const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        codeAction.diagnostics = [diagnostic];
        codeAction.command = command;
        return codeAction;
      };
      // The last evidence is the strongest: verification evidence is appended after the static one.
      const evidence = finding.evidence.at(-1);
      return [
        action(vscode.l10n.t('Probato PR: Dismiss this finding'), { command: 'probatoPR.dismissFinding', title: '', arguments: [{ finding }] }),
        ...(evidence ? [action(vscode.l10n.t('Probato PR: Show the evidence'), { command: 'probatoPR.openEvidence', title: '', arguments: [evidence.evidenceId] })] : []),
        action(vscode.l10n.t('Probato PR: Open the Review Summary'), { command: 'probatoPR.showResults', title: '' }),
      ];
    });
  }
}
