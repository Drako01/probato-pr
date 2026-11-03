import * as vscode from 'vscode';
import type { CommandEvidence } from '../core/model';
import { checkStatusLabel, revisionLabel } from '../core/labels';
import type { ReviewSession } from '../extension/review-session';
import { renderMarkdown } from '../reports/markdown';

export const REPORT_SCHEME = 'probato-report';
export const EVIDENCE_SCHEME = 'probato-evidence';
export const REPORT_URI = vscode.Uri.from({ scheme: REPORT_SCHEME, path: '/Probato PR Review.md' });

export function evidenceUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EVIDENCE_SCHEME, path: `/${id}.log` });
}

function renderEvidence(e: CommandEvidence): string {
  const revision = `${revisionLabel(e.revision)}${e.commitSha ? ` ${e.commitSha}` : ''}${e.dirty ? ` ${vscode.l10n.t('(with uncommitted changes)')}` : ''}`;
  const signal = e.signal ? ` ${vscode.l10n.t('(signal {0})', e.signal)}` : '';
  const truncated = e.outputTruncated ? ` ${vscode.l10n.t('(excerpt truncated to the final output)')}` : '';
  return [
    vscode.l10n.t('Probato PR — command evidence {0}', e.id),
    '',
    vscode.l10n.t('Command: {0}', e.commandLine),
    vscode.l10n.t('Directory: {0}', e.cwd || vscode.l10n.t('(repository root)')),
    vscode.l10n.t('Revision: {0}', revision),
    vscode.l10n.t('Started: {0}', e.startedAt),
    vscode.l10n.t('Duration: {0} s', (e.durationMs / 1000).toFixed(2)),
    vscode.l10n.t('Outcome: {0}', checkStatusLabel(e.outcome)),
    vscode.l10n.t('Exit code: {0}{1}', String(e.exitCode), signal),
    vscode.l10n.t('Output: sha256 {0}{1}', e.outputSha256, truncated),
    ...(e.errorMessage ? [vscode.l10n.t('Error: {0}', e.errorMessage)] : []),
    '',
    vscode.l10n.t('--- output (secrets redacted) ---'),
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
