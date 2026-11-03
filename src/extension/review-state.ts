import * as vscode from 'vscode';
import { isWithin } from '../core/paths';

/** Git reads disk: never silently review or publish while an editor contains a newer unsaved version. */
export function ensureSavedRepository(root: string): void {
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === 'file' && isWithin(root, d.uri.fsPath))) {
    throw new Error(vscode.l10n.t('Save your files before reviewing, verifying or publishing repository changes.'));
  }
}
