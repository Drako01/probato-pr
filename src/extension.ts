import * as vscode from 'vscode';
import type { AIReviewProvider } from './ai/ai-provider';
import { AnthropicProvider } from './ai/anthropic-provider';
import { VsCodeLanguageModelProvider } from './ai/vscode-lm-provider';
import { createDefaultAnalyzers } from './analyzers';
import type { ReviewResult } from './core/model';
import { ReviewEngine } from './core/review-engine';
import { ReviewController } from './extension/review-controller';
import { ReviewSession } from './extension/review-session';
import { readSettings } from './extension/settings';
import { GitClient } from './git/git-client';
import { GitHubClient } from './github/github-client';
import { HistoryStore } from './infrastructure/history-store';
import { NodeProcessRunner } from './infrastructure/process-runner';
import { FindingDiagnostics } from './ui/diagnostics';
import { EVIDENCE_SCHEME, REPORT_SCHEME, ReviewDocuments } from './ui/documents';
import { createFindingsView } from './ui/findings-tree';
import { OverviewTreeProvider } from './ui/overview-tree';
import { ReviewStatusBar } from './ui/status-bar';
import { SUMMARY_VIEW_TYPE, SummaryPanel } from './ui/summary-panel';
import { VerificationTreeProvider } from './ui/verification-tree';
import { VerificationEngine } from './verification/verification-engine';

const ANTHROPIC_KEY_SECRET = 'probatoPR.anthropicApiKey';
const GITHUB_SCOPES = ['repo'];

let activeSession: ReviewSession | undefined;

/** Composition root: wires infrastructure, domain services and UI. Nothing runs until a command is invoked. */
/** Read-only API returned from activate(), used by integration tests and other extensions. */
export interface ProbatoApi {
  readonly currentReview: () => ReviewResult | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<ProbatoApi> {
  const log = vscode.window.createOutputChannel('Probato PR', { log: true });
  const manifest = context.extension.packageJSON as { version?: unknown };
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  const settings = () => readSettings((message) => {
    log.warn(message);
  });

  const runner = new NodeProcessRunner();
  const git = new GitClient(runner, { timeoutMs: 60_000, maxBytes: settings().review.maxDiffBytes });
  const history = new HistoryStore(context.storageUri?.fsPath);
  const session = new ReviewSession(context.workspaceState, history, (error) => {
    log.warn(`Could not save review history: ${error instanceof Error ? error.message : String(error)}`);
  });
  activeSession = session;

  let githubToken: string | undefined;
  const github = new GitHubClient(
    (input, init) => fetch(input, init),
    async () => {
      githubToken ??= (await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true }))?.accessToken;
      return githubToken;
    },
  );

  const aiProvider = (): AIReviewProvider | undefined => {
    const ai = settings().ai;
    switch (ai.provider) {
      case 'anthropic':
        return new AnthropicProvider(() => Promise.resolve(context.secrets.get(ANTHROPIC_KEY_SECRET)), ai.anthropicModel);
      case 'vscode-lm':
        return new VsCodeLanguageModelProvider();
      case 'none':
        return undefined;
    }
  };

  const summary = new SummaryPanel(session, context.extensionUri, log);
  const controller = new ReviewController({
    session,
    git,
    engine: new ReviewEngine(createDefaultAnalyzers(), version),
    verification: new VerificationEngine(runner, git),
    github,
    signInToGitHub: async () => {
      const auth = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
      githubToken = auth.accessToken;
      return true;
    },
    aiProvider,
    settings,
    log,
    showSummary: (preserveFocus) => {
      summary.show(preserveFocus);
    },
  });

  const documents = new ReviewDocuments(session);
  context.subscriptions.push(
    log,
    session,
    documents,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, documents),
    vscode.workspace.registerTextDocumentContentProvider(EVIDENCE_SCHEME, documents),
    new FindingDiagnostics(session),
    summary,
    vscode.window.registerWebviewPanelSerializer(SUMMARY_VIEW_TYPE, summary),
    new ReviewStatusBar(session),
    registerTree('probatoPR.overview', new OverviewTreeProvider(session)),
    createFindingsView(session, context.workspaceState),
    registerTree('probatoPR.verification', new VerificationTreeProvider(session)),
    vscode.commands.registerCommand('probatoPR.reviewCurrentChanges', (arg?: unknown) => controller.reviewLocal('working', reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewStagedChanges', (arg?: unknown) => controller.reviewLocal('staged', reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewBranch', (arg?: unknown) => controller.reviewBranch(reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewCommit', (arg?: unknown) => controller.reviewCommit(reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewPullRequest', () => controller.reviewPullRequest()),
    vscode.commands.registerCommand('probatoPR.verify', () => controller.verify()),
    vscode.commands.registerCommand('probatoPR.aiReview', () => controller.aiReview()),
    vscode.commands.registerCommand('probatoPR.showResults', () => {
      controller.showResults();
    }),
    vscode.commands.registerCommand('probatoPR.openMarkdownReport', () => controller.openMarkdownReport()),
    vscode.commands.registerCommand('probatoPR.exportReport', () => controller.exportReport()),
    vscode.commands.registerCommand('probatoPR.openFinding', (id: string, viewColumn?: vscode.ViewColumn) => controller.openFinding(id, viewColumn)),
    vscode.commands.registerCommand('probatoPR.openEvidence', (id: string) => controller.openEvidence(id)),
    vscode.commands.registerCommand('probatoPR.cancel', () => session.cancel()),
    vscode.commands.registerCommand('probatoPR.dismissFinding', (node?: { finding?: { id: string } }) => (node?.finding ? session.dismiss(node.finding.id) : undefined)),
    vscode.commands.registerCommand('probatoPR.restoreDismissed', () => session.restoreDismissed()),
    vscode.commands.registerCommand('probatoPR.clearHistory', async () => {
      await session.clear();
      void vscode.window.showInformationMessage(vscode.l10n.t('Probato PR review history deleted from this workspace.'));
    }),
    vscode.commands.registerCommand('probatoPR.setAnthropicApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: vscode.l10n.t('Anthropic API key'),
        prompt: vscode.l10n.t('Stored in VS Code SecretStorage (OS keychain). Leave empty to remove the stored key.'),
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      if (key.trim() === '') {
        await context.secrets.delete(ANTHROPIC_KEY_SECRET);
      } else {
        await context.secrets.store(ANTHROPIC_KEY_SECRET, key.trim());
      }
      void vscode.window.showInformationMessage(key.trim() ? vscode.l10n.t('Anthropic API key saved.') : vscode.l10n.t('Anthropic API key removed.'));
    }),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') {
        githubToken = undefined;
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      session.updateViews();
    }),
  );

  await vscode.commands.executeCommand('setContext', 'probatoPR.busy', false);
  const stored = await history.load();
  if (stored.latest) {
    session.restore(stored.latest.review, stored.latest.verified);
  }
  log.info(`Probato PR ${version} activated (VS Code ${vscode.version}, ${process.platform}).`);
  return { currentReview: () => session.current };
}

/** Repository chosen by the caller: a Uri (API, explorer) or a SourceControl from the SCM view (`rootUri`). */
function reviewTarget(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const rootUri = (arg as { rootUri?: unknown } | undefined)?.rootUri;
  return rootUri instanceof vscode.Uri ? rootUri : undefined;
}

function registerTree<T>(id: string, provider: vscode.TreeDataProvider<T> & vscode.Disposable): vscode.Disposable {
  const view = vscode.window.createTreeView(id, { treeDataProvider: provider });
  return vscode.Disposable.from(view, provider);
}

/** Cancels any running operation; the runner kills child process trees on abort. */
export function deactivate(): void {
  activeSession?.cancel();
  activeSession = undefined;
}
