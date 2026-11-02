import * as vscode from 'vscode';
import type { CommandEvidence } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { renderMarkdown } from '../reports/markdown';

export const REPORT_SCHEME = 'probato-report';
export const EVIDENCE_SCHEME = 'probato-evidence';
export const REPORT_URI = vscode.Uri.from({ scheme: REPORT_SCHEME, path: '/Probato PR Review.md' });

export function evidenceUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EVIDENCE_SCHEME, path: `/${id}.log` });
}

function renderEvidence(e: CommandEvidence): string {
  return [
    `Probato PR — command evidence ${e.id}`,
    '',
    `Command:    ${e.commandLine}`,
    `Directory:  ${e.cwd || '(repository root)'}`,
    `Revision:   ${e.revision}${e.commitSha ? ` ${e.commitSha}` : ''}${e.dirty ? ' + uncommitted changes' : ''}`,
    `Started:    ${e.startedAt}`,
    `Duration:   ${(e.durationMs / 1000).toFixed(2)}s`,
    `Outcome:    ${e.outcome}`,
    `Exit code:  ${String(e.exitCode)}${e.signal ? ` (signal ${e.signal})` : ''}`,
    `Output:     sha256 ${e.outputSha256}${e.outputTruncated ? ' (excerpt below is truncated: last part only)' : ''}`,
    ...(e.errorMessage ? [`Error:      ${e.errorMessage}`] : []),
    '',
    '--- output (secrets redacted) ---',
    e.outputExcerpt,
  ].join('\n');
}

/** Read-only virtual documents for the review report and each command's evidence; nothing is written to the repo. */
export class ReviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: ReviewSession) {
    this.subscription = session.onDidChange(() => {
      this.emitter.fire(REPORT_URI);
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const review = this.session.current;
    if (!review) {
      return vscode.l10n.t('No review yet. Run "Probato PR: Review Current Changes".');
    }
    if (uri.scheme === REPORT_SCHEME) {
      return renderMarkdown(review);
    }
    const id = uri.path.replace(/^\//, '').replace(/\.log$/, '');
    const evidence = review.evidence.find((e) => e.id === id);
    if (evidence?.kind === 'command-run') {
      return renderEvidence(evidence);
    }
    return evidence ? `${evidence.description}\n\n${evidence.excerpt ?? ''}` : vscode.l10n.t('Evidence {0} is not part of the current review.', id);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
