import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFinding } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { verificationLabel } from './presentation';

function severityOf(f: ReviewFinding): vscode.DiagnosticSeverity {
  const backed = f.verification === 'confirmed' || f.verification === 'evidenced';
  if ((f.severity === 'critical' || f.severity === 'high') && backed) {
    return vscode.DiagnosticSeverity.Error;
  }
  return f.severity === 'low' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
}

/** Publishes visible findings as editor diagnostics (Problems panel + squiggles) through the official API. */
export class FindingDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('probato-pr');
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: ReviewSession) {
    this.subscription = session.onDidChange(() => {
      this.refresh();
    });
  }

  private refresh(): void {
    this.collection.clear();
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
      diagnostic.source = 'Probato PR';
      diagnostic.code = finding.ruleId;
      const list = byFile.get(finding.location.file) ?? [];
      list.push(diagnostic);
      byFile.set(finding.location.file, list);
    }
    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(path.join(review.repository.root, ...file.split('/'))), diagnostics);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}
