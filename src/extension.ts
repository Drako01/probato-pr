import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewResult } from './core/model';
import { setTranslator } from './core/i18n';
import { AnalyzerWorkerHost } from './infrastructure/analyzer-worker-host';
import { aiProviderLabel, createAiProvider } from './extension/ai-providers';
import { AiSetup } from './extension/ai-setup';
import { DeliveryController } from './extension/delivery-controller';
import { LocalDeliveryController } from './extension/local-delivery-controller';
import { ensureSavedRepository } from './extension/review-state';
import { assertReviewCurrent, repositorySnapshot } from './git/repository-snapshot';
import { isWithin } from './core/paths';
import { ReviewController } from './extension/review-controller';
import { ReviewSession } from './extension/review-session';
import { readSettings } from './extension/settings';
import { GitClient } from './git/git-client';
import { GitHubClient } from './github/github-client';
import { HistoryStore } from './infrastructure/history-store';
import { NodeProcessRunner } from './infrastructure/process-runner';
import { FindingCodeActions, FindingDiagnostics } from './ui/diagnostics';
import { EVIDENCE_SCHEME, REPORT_SCHEME, ReviewDocuments } from './ui/documents';
import { createFindingsView } from './ui/findings-tree';
import { HomePanel, HOME_VIEW_TYPE, isSection } from './ui/home-panel';
import { parseHomeSetting } from './extension/home-settings';
import { OverviewTreeProvider } from './ui/overview-tree';
import { ReviewStatusBar } from './ui/status-bar';
import { SUMMARY_VIEW_TYPE, SummaryPanel } from './ui/summary-panel';
import { VerificationTreeProvider } from './ui/verification-tree';
import { ApprovedChecks } from './verification/approved-checks';
import { VerificationEngine } from './verification/verification-engine';

const GITHUB_SCOPES = ['repo'];

let activeSession: ReviewSession | undefined;

/** Composition root: wires infrastructure, domain services and UI. Nothing runs until a command is invoked. */
/** Read-only API returned from activate(), used by integration tests and other extensions. */
export interface ProbatoApi {
  readonly currentReview: () => ReviewResult | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<ProbatoApi> {
  setTranslator((template, ...args) => vscode.l10n.t(template, ...args));
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

  const aiSetup = new AiSetup(context.secrets, context.globalState, settings, log);
  const summary = new SummaryPanel(session, context.extensionUri, log, () => aiProviderLabel(settings().ai));
  const analyzerWorker = new AnalyzerWorkerHost({ workerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'analyzer-worker.js').fsPath, version, locale: vscode.env.language });
  context.subscriptions.push(analyzerWorker);
  const controller = new ReviewController({
    session,
    git,
    engine: analyzerWorker,
    verification: new VerificationEngine(runner, git),
    approvals: new ApprovedChecks(context.workspaceState),
    github,
    signInToGitHub: async () => {
      const auth = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
      githubToken = auth.accessToken;
      return true;
    },
    aiProvider: () => createAiProvider(settings().ai, context.secrets),
    settings,
    log,
    showSummary: (preserveFocus) => {
      summary.show(preserveFocus);
    },
    connectAi: () => aiSetup.run(),
    runMutation: async (request) => { const { MutationEngine } = await import('./mutation-runtime.js'); return new MutationEngine(runner, git).run(request); },
  });

  const localDelivery = new LocalDeliveryController(session, git);
  const delivery = new DeliveryController({
    session, git, github, state: context.workspaceState, log,
    signInToGitHub: async () => {
      githubToken = (await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true })).accessToken;
      return true;
    },
    ensureReviewCurrent: async (review) => {
      ensureSavedRepository(review.repository.root);
      await assertReviewCurrent(git, review);
    },
  });
  let selectedFolder = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === context.workspaceState.get<string>('probatoPR.home.repository')) ?? vscode.workspace.workspaceFolders?.[0];
  const home = new HomePanel(session, context.extensionUri, {
    loadContext: async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.some((folder) => folder.uri.toString() === selectedFolder?.uri.toString())) selectedFolder = folders[0];
      const folder = selectedFolder;
      let repository: { name: string; branch: string; changes: number } | undefined;
      if (folder && vscode.workspace.isTrusted) {
        try {
          const root = await git.topLevel(folder.uri.fsPath);
          if (root) {
            const [branch, status] = await Promise.all([
              git.currentBranch(root), git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
            ]);
            // A rename has a second NUL-delimited path; count status records, not paths.
            const records = status.split('\0');
            let changes = 0;
            for (let i = 0; i < records.length; i++) {
              const record = records[i];
              if (!record) continue;
              changes++;
              if (/^[RC]|^.[RC]/.test(record)) i++;
            }
            repository = { name: path.basename(root), branch: branch ?? vscode.l10n.t('Detached HEAD'), changes };
          }
        } catch (error) { log.warn(`Home repository status unavailable: ${String(error)}`); }
      }
      const auth = await Promise.resolve(vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true })).catch((error: unknown) => { log.warn(`Home account status unavailable: ${String(error)}`); return undefined; });
      const config = vscode.workspace.getConfiguration('probatoPR');
      const keys = ['home.openOnStartup', 'review.onSave', 'review.baseBranch', 'review.maxFiles', 'verification.baseline', 'verification.timeoutSeconds', 'ai.provider', 'ai.includeFileContent', 'mutation.timeoutSeconds', 'mutation.concurrency', 'mutation.memoryMb', 'mutation.maxFiles', 'mutation.gateEnabled', 'mutation.failOnDegradation', 'mutation.minimumScore', 'mutation.tolerancePoints'];
      const storedHistory = (await history.load()).history;
      const latest = session.current;
      // Persistence is asynchronous; include the current review before its disk write completes.
      const recentHistory = latest ? [{
        id: latest.id, createdAt: latest.createdAt, repository: latest.repository.name,
        scope: latest.scope.label, risk: latest.risk.level, findings: latest.findings.length,
      }, ...storedHistory.filter((entry) => entry.id !== latest.id)].slice(0, 20) : storedHistory;
      return {
        trusted: vscode.workspace.isTrusted,
        ...(repository ? { repository } : {}),
        ...(auth ? { github: auth.account.label } : {}),
        settings: Object.fromEntries(keys.map((key) => [key, config.get(key)])),
        userSettings: Object.fromEntries(keys.map((key) => { const value = config.inspect(key); return [key, value?.globalValue ?? value?.defaultValue]; })),
        workspaceSettings: Object.fromEntries(keys.map((key) => { const value = config.inspect(key); return [key, value?.workspaceValue ?? value?.globalValue ?? value?.defaultValue]; })),
        history: recentHistory,
      };
    },
    execute: async (action) => {
      if (action === 'refresh') return;
      if (action === 'selectRepository') {
        const choices = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder }));
        if (!choices.length) { await vscode.commands.executeCommand('workbench.action.files.openFolder'); return; }
        const chosen = await vscode.window.showQuickPick(choices, { title: vscode.l10n.t('Select a repository') });
        if (chosen) { selectedFolder = chosen.folder; await context.workspaceState.update('probatoPR.home.repository', chosen.folder.uri.toString()); }
        return;
      }
      if (action === 'openSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:armotusitio.probato-pr'); return; }
      if (action === 'connectGitHub') {
        githubToken = (await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true })).accessToken;
        return;
      }
      // Only declared HomeAction values arrive here; the panel never accepts arbitrary command IDs.
      await vscode.commands.executeCommand(`probatoPR.${action}`, ...(['reviewCurrentChanges', 'reviewStagedChanges', 'reviewBranch', 'reviewCommit'].includes(action) && selectedFolder ? [selectedFolder.uri] : []));
    },
    saveSetting: async (key, value, target) => {
      const setting = parseHomeSetting({ key, value, target });
      if (!setting) throw new Error(vscode.l10n.t('Invalid setting value.'));
      if (setting.target === 'workspace' && (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length)) throw new Error(vscode.l10n.t('Open a folder before saving workspace settings.'));
      if (!vscode.workspace.isTrusted && setting.target === 'workspace') throw new Error(vscode.l10n.t('Trust this workspace before changing its settings.'));
      await vscode.workspace.getConfiguration('probatoPR').update(setting.key, setting.value, setting.target === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    },
    onError: (error) => { log.warn(String(error)); void vscode.window.showErrorMessage(vscode.l10n.t('Probato Home: {0}', error instanceof Error ? error.message : String(error))); },
  });
  const overviewProvider = new OverviewTreeProvider(session);
  const overviewView = vscode.window.createTreeView('probatoPR.overview', { treeDataProvider: overviewProvider });
  let sidebarVisited = false;
  const openHomeOnFirstVisit = () => {
    if (!overviewView.visible || sidebarVisited) return;
    sidebarVisited = true;
    if (vscode.workspace.getConfiguration('probatoPR').get<boolean>('home.openOnStartup', true)) home.show('home', true);
  };
  context.subscriptions.push(home, overviewView, overviewProvider,
    vscode.window.registerWebviewPanelSerializer(HOME_VIEW_TYPE, home),
    // Optional section argument (allowlisted) lets automation open a specific Home section, e.g. 'settings'.
    vscode.commands.registerCommand('probatoPR.openHome', (section?: unknown) => { home.show(isSection(section) ? section : 'home'); }),
    overviewView.onDidChangeVisibility(openHomeOnFirstVisit),
  );
  openHomeOnFirstVisit();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSaveRoot: string | undefined;
  const documents = new ReviewDocuments(session);
  const diagnostics = new FindingDiagnostics(session);
  context.subscriptions.push(
    log,
    session,
    documents,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, documents),
    vscode.workspace.registerTextDocumentContentProvider(EVIDENCE_SCHEME, documents),
    diagnostics,
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FindingCodeActions(diagnostics), { providedCodeActionKinds: FindingCodeActions.kinds }),
    summary,
    vscode.window.registerWebviewPanelSerializer(SUMMARY_VIEW_TYPE, summary),
    new ReviewStatusBar(session),
    createFindingsView(session, context.workspaceState),
    registerTree('probatoPR.verification', new VerificationTreeProvider(session)),
    vscode.commands.registerCommand('probatoPR.reviewCurrentChanges', (arg?: unknown) => controller.reviewLocal('working', reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewStagedChanges', (arg?: unknown) => controller.reviewLocal('staged', reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewBranch', (arg?: unknown) => controller.reviewBranch(reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewCommit', (arg?: unknown) => controller.reviewCommit(reviewTarget(arg))),
    vscode.commands.registerCommand('probatoPR.reviewPullRequest', () => controller.reviewPullRequest()),
    vscode.commands.registerCommand('probatoPR.localGit', () => localDelivery.open()),
    vscode.commands.registerCommand('probatoPR.delivery', () => delivery.open()),
    vscode.commands.registerCommand('probatoPR.publishPullRequest', () => delivery.publishPullRequest()),
    vscode.commands.registerCommand('probatoPR.publishReview', () => delivery.publishReview()),
    vscode.commands.registerCommand('probatoPR.publishAnalysis', () => delivery.publishAnalysis()),
    vscode.commands.registerCommand('probatoPR.pullRequestStatus', () => delivery.status()),
    vscode.commands.registerCommand('probatoPR.mergePullRequest', () => delivery.merge()),
    vscode.commands.registerCommand('probatoPR.importSarif', () => controller.importExternalReport()),
    vscode.commands.registerCommand('probatoPR.verify', () => controller.verify()),
    vscode.commands.registerCommand('probatoPR.mutationTesting', () => controller.mutationTesting()),
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
    vscode.commands.registerCommand('probatoPR.forgetApprovedChecks', () => controller.forgetApprovedChecks()),
    vscode.commands.registerCommand('probatoPR.clearHistory', async () => {
      if (session.busyLabel) { void vscode.window.showWarningMessage(vscode.l10n.t('Cancel the running operation before deleting review history.')); return; }
      await session.exclusive(vscode.l10n.t('Delete Local Review History'), () => session.clear());
      void vscode.window.showInformationMessage(vscode.l10n.t('Probato PR review history deleted from this workspace.'));
    }),
    vscode.commands.registerCommand('probatoPR.connectAi', () => aiSetup.run()),
    vscode.commands.registerCommand('probatoPR.forgetAiKeys', () => aiSetup.forgetKeys()),
    vscode.commands.registerCommand('probatoPR.copyPullRequestDescription', () => controller.copyPullRequestDescription()),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') {
        githubToken = undefined;
      }
    }),
    { dispose: () => { clearTimeout(saveTimer); } },
    vscode.workspace.onDidSaveTextDocument((document) => {
      const review = session.current;
      const root = review?.repository.root ?? pendingSaveRoot;
      if (!root || document.uri.scheme !== 'file' || !isWithin(root, document.uri.fsPath)) return;
      if (session.busyLabel) return;
      session.invalidate();
      clearTimeout(saveTimer);
      if ((review && review.scope.kind !== 'working') || !vscode.workspace.getConfiguration('probatoPR').get<boolean>('review.onSave', false)) { pendingSaveRoot = undefined; return; }
      pendingSaveRoot = root;
      saveTimer = setTimeout(() => {
        pendingSaveRoot = undefined;
        if (vscode.workspace.isTrusted && !session.busyLabel) void controller.reviewLocal('working', vscode.Uri.file(root));
      }, 600);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      session.updateViews();
    }),
  );

  await vscode.commands.executeCommand('setContext', 'probatoPR.busy', false);
  const stored = await history.load();
  if (stored.latest?.review.snapshot && stored.latest.review.repository.root && vscode.workspace.isTrusted) {
    try {
      const current = await repositorySnapshot(git, stored.latest.review.repository.root);
      if (current.fingerprint === stored.latest.review.snapshot) session.restore(stored.latest.review, stored.latest.verified);
    } catch (error) { log.warn(`Stored review could not be restored: ${String(error)}`); }
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
