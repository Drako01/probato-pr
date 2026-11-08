import * as vscode from 'vscode';
import type { ReviewSession } from './review-session';

export type ProgressMessage = (message: string) => void;

/**
 * Runs one session-exclusive operation behind cancellable progress UI. Cancelling the progress aborts the
 * session operation, so every controller shares the same single-operation and cancellation semantics.
 */
export function exclusiveWithProgress(
  session: Pick<ReviewSession, 'exclusive' | 'cancel'>,
  label: string,
  location: vscode.ProgressLocation,
  title: string,
  operation: (signal: AbortSignal, report: ProgressMessage) => Promise<void>,
): Promise<void> {
  return session.exclusive(label, (signal) =>
    vscode.window.withProgress({ location, title, cancellable: true }, async (progress, token) => {
      const subscription = token.onCancellationRequested(() => session.cancel());
      try {
        await operation(signal, (message) => { progress.report({ message }); });
      } finally {
        subscription.dispose();
      }
    }),
  );
}
