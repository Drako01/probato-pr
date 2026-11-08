import * as vscode from 'vscode';
import { AiProviderError } from '../ai/ai-provider';
import { InvalidBaseUrlError } from '../ai/openai-compatible-provider';
import { redactSecrets } from '../core/secrets';
import { CancelledError, GitError, GitNotFoundError, OutputTooLargeError } from '../git/git-client';
import { NoChangesError } from '../git/local-changes';
import { GitHubError } from '../github/github-client';
import { BusyError } from './review-session';

/**
 * Turns a failed review command into an actionable message plus a full log entry. Messages and logs are
 * redacted: Git and provider errors can echo remote URLs with embedded credentials or API keys.
 */
export async function reportCommandError(error: unknown, log: Pick<vscode.LogOutputChannel, 'error' | 'show'>): Promise<void> {
  const showLog = vscode.l10n.t('Show Log');
  if (error instanceof BusyError) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Probato PR is busy ({0}). Wait for it to finish or cancel it.', error.activity));
    return;
  }
  if (error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')) {
    vscode.window.setStatusBarMessage(vscode.l10n.t('Probato PR: cancelled'), 5000);
    return;
  }
  if (error instanceof NoChangesError) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to review: no {0}. Edit some files, or review a branch or a commit instead.', error.scopeLabel));
    return;
  }
  log.error(redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  let message: string;
  const actions: string[] = [showLog];
  const openSettings = vscode.l10n.t('Open Settings');
  if (error instanceof GitNotFoundError) {
    message = vscode.l10n.t('Git was not found. Install Git (https://git-scm.com/downloads), make sure it is on PATH, and reload VS Code.');
  } else if (error instanceof OutputTooLargeError) {
    message = vscode.l10n.t('The diff is larger than probatoPR.review.maxDiffBytes. Review fewer changes or raise the limit.');
    actions.unshift(openSettings);
  } else if (error instanceof GitError) {
    message = vscode.l10n.t('Git error: {0}', error.message);
  } else if (error instanceof GitHubError || error instanceof AiProviderError || error instanceof InvalidBaseUrlError) {
    message = error.message;
  } else {
    message = vscode.l10n.t('Unexpected error: {0}', error instanceof Error ? error.message : String(error));
  }
  const answer = await vscode.window.showErrorMessage(redactSecrets(message), ...actions);
  if (answer === showLog) {
    log.show(true);
  } else if (answer === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'probatoPR.review');
  }
}
