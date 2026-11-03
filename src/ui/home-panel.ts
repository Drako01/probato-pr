import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { comparisonView } from './review-comparison-view-model';
import { mutationView } from './mutation-view-model';
import { riskLabel } from '../core/labels';
import type { ReviewSession } from '../extension/review-session';
import type { HistoryEntry } from '../infrastructure/history-store';
import { parseHomeSetting } from '../extension/home-settings';

export const HOME_VIEW_TYPE = 'probatoPR.home';
export const HOME_ACTIONS = ['reviewCurrentChanges', 'reviewStagedChanges', 'reviewBranch', 'reviewCommit', 'reviewPullRequest', 'verify', 'mutationTesting', 'showResults', 'localGit', 'delivery', 'publishPullRequest', 'publishReview', 'mergePullRequest', 'pullRequestStatus', 'connectGitHub', 'connectAi', 'openSettings', 'selectRepository', 'exportReport', 'clearHistory', 'forgetApprovedChecks', 'forgetAiKeys', 'cancel', 'refresh'] as const;
export type HomeAction = (typeof HOME_ACTIONS)[number];
export type HomeSection = 'home' | 'review' | 'verify' | 'github' | 'settings' | 'history';
export interface HomeContext {
  readonly repository?: { readonly name: string; readonly branch: string; readonly changes: number };
  readonly github?: string;
  readonly trusted: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly userSettings?: Readonly<Record<string, unknown>>;
  readonly workspaceSettings?: Readonly<Record<string, unknown>>;
  readonly history: readonly HistoryEntry[];
}
export interface HomeDependencies {
  loadContext(): Promise<HomeContext>;
  execute(action: HomeAction): Promise<unknown>;
  saveSetting(key: string, value: unknown, target: 'user' | 'workspace'): Promise<void>;
  onError(error: unknown): void;
}

/** Persistent operational surface. Messages carry allowlisted intents, never executable command IDs. */
export class HomePanel implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private section: HomeSection = 'home';
  private generation = 0;
  private refreshing = false;
  private dirty = false;
  private panelSubscriptions: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable;

  constructor(private readonly session: ReviewSession, private readonly extensionUri: vscode.Uri, private readonly dependencies: HomeDependencies) {
    this.subscriptions = vscode.Disposable.from(
      session.onDidChange(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('probatoPR')) void this.refresh(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
      vscode.authentication.onDidChangeSessions(() => { void this.refresh(); }),
    );
  }

  show(section: HomeSection = 'home', preserveFocus = false): void {
    this.section = section;
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      void this.panel.webview.postMessage({ type: 'navigate', section });
      void this.refresh();
      return;
    }
    this.attach(vscode.window.createWebviewPanel(HOME_VIEW_TYPE, vscode.l10n.t('Probato PR Home'), { viewColumn: vscode.ViewColumn.Active, preserveFocus }, this.options()));
  }

  deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel) { panel.dispose(); return Promise.resolve(); }
    panel.webview.options = this.options();
    this.attach(panel);
    return Promise.resolve();
  }

  private options(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return { enableScripts: true, enableCommandUris: false, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = vscode.l10n.t('Probato PR Home');
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'logo.svg');
    panel.webview.html = homeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'logo.svg')).toString(), panel.webview.cspSource);
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handle(raw).catch((error: unknown) => {
          this.dependencies.onError(error);
          void panel.webview.postMessage({ type: 'notice', text: vscode.l10n.t('The action could not be completed. Check the notification for details.'), error: true });
        });
      }),
      panel.onDidChangeViewState((event) => { if (event.webviewPanel.visible) void this.refresh(); }),
      panel.onDidDispose(() => {
        this.generation++;
        this.panelSubscriptions.forEach((subscription) => { subscription.dispose(); });
        this.panelSubscriptions = [];
        this.panel = undefined;
      }),
    ];
  }

  private async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message.type === 'ready') {
      if (isSection(message.section)) this.section = message.section;
      await this.panel?.webview.postMessage({ type: 'navigate', section: this.section });
      await this.refresh();
    } else if (message.type === 'navigate' && isSection(message.section)) {
      this.section = message.section;
    } else if (message.type === 'action' && typeof message.action === 'string' && HOME_ACTIONS.includes(message.action as HomeAction)) {
      await this.dependencies.execute(message.action as HomeAction);
      await this.refresh();
    } else if (message.type === 'compareReview' && typeof message.id === 'string' && message.id.length <= 200) {
      await this.session.compareWith(message.id);
      await this.refresh();
    } else if (message.type === 'clearComparison') {
      this.session.clearComparison();
    } else if (message.type === 'openComparisonFinding' && typeof message.id === 'string' && this.session.current?.findings.some((finding) => finding.id === message.id)) {
      await vscode.commands.executeCommand('probatoPR.openFinding', message.id);
    } else if (message.type === 'openComparisonEvidence' && typeof message.id === 'string' && this.session.current?.evidence.some((evidence) => evidence.id === message.id)) {
      await vscode.commands.executeCommand('probatoPR.openEvidence', message.id);
    } else if (message.type === 'setting') {
      const setting = parseHomeSetting({ key: message.key, value: message.value, target: message.target });
      if (!setting) return;
      await this.dependencies.saveSetting(setting.key, setting.value, setting.target);
      await this.panel?.webview.postMessage({ type: 'notice', text: vscode.l10n.t('Preference saved.'), error: false });
      await this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    if (this.refreshing) { this.dirty = true; return; }
    this.refreshing = true;
    const generation = this.generation;
    try {
      const [context, candidates] = await Promise.all([this.dependencies.loadContext(), this.session.comparisonOptions()]);
      if (generation !== this.generation) return;
      const review = this.session.current;
      await this.panel.webview.postMessage({ type: 'state', state: {
        ...context,
        history: context.history.map((entry) => ({ ...entry, risk: localizedRisk(entry.risk) })),
        busy: this.session.busyLabel,
        mutation: review?.mutation ? mutationView(review.mutation, review.evidence) : undefined,
        comparisonOptions: candidates.map((candidate) => ({ id: candidate.id, label: `${candidate.scope} · ${candidate.createdAt}` })),
        comparison: this.session.comparison ? comparisonView(this.session.comparison) : undefined,
        review: review ? { repository: review.repository.name, scope: review.scope.label, risk: localizedRisk(review.risk.level), findings: this.session.visibleFindings().length, checks: review.checks.length, createdAt: review.createdAt, hasLocalCheckout: Boolean(review.repository.root), analysisMs: review.performance?.analysisMs, reproducibilityLimitations: review.reproducibility?.filter((check) => check.status === 'inconclusive').flatMap((check) => check.reasons) } : undefined,
        checks: this.session.plan.map((check) => ({ id: check.id, title: check.label })),
      } });
    } catch (error) {
      this.dependencies.onError(error);
      if (generation === this.generation) await this.panel.webview.postMessage({ type: 'notice', text: vscode.l10n.t('Workspace status could not be loaded. Try refreshing.'), error: true, loadError: true });
    } finally {
      this.refreshing = false;
      if (this.dirty) { this.dirty = false; void this.refresh(); }
    }
  }

  dispose(): void { this.subscriptions.dispose(); this.panel?.dispose(); }
}

function localizedRisk(value: string): string {
  return riskLabel(value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : 'unknown');
}

function isSection(value: unknown): value is HomeSection {
  return typeof value === 'string' && ['home', 'review', 'verify', 'github', 'settings', 'history'].includes(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function homeHtml(logo: string, cspSource: string): string {
  const nonce = randomBytes(18).toString('base64');
  const labels = {
    mutationMetricHelp: vscode.l10n.t('Stryker Mutation Score counts killed and timed-out mutants as detected. The killed-only metric excludes timeouts; incomplete runs do not establish a regression.'), mutationTitle: vscode.l10n.t('Mutation testing and differential gate'), mutationRun: vscode.l10n.t('Run mutation testing (optional)'),
    mutationOptional: vscode.l10n.t('Mutation testing is optional. You approve the impacted files and execution limits before Stryker runs.'),
    mutationExecution: vscode.l10n.t('Execution'), mutationVerification: vscode.l10n.t('Verification result'), mutationBaseline: vscode.l10n.t('Baseline comparability'),
    mutationQuality: vscode.l10n.t('Quality trend'), mutationGate: vscode.l10n.t('Quality gate'), mutationScore: vscode.l10n.t('Stryker Mutation Score'),
    mutationKilledOnly: vscode.l10n.t('Killed-only score (separate metric)'), mutationDelta: vscode.l10n.t('Change in percentage points'),
    mutationTimeout: vscode.l10n.t('Total mutation timeout (seconds)'), mutationTimeoutHelp: vscode.l10n.t('One total time budget covers preparation and both revisions.'), mutationConcurrency: vscode.l10n.t('Mutation worker concurrency'), mutationMemory: vscode.l10n.t('Memory limit per worker (MB)'), mutationFiles: vscode.l10n.t('Maximum impacted source files'),
    mutationGateEnabled: vscode.l10n.t('Enable the mutation quality gate'), mutationGateHelp: vscode.l10n.t('Gate policy does not authorize execution. Mutation testing always requires explicit approval.'),
    mutationFailDegradation: vscode.l10n.t('Fail the gate on demonstrated degradation'), mutationMinimum: vscode.l10n.t('Absolute minimum Mutation Score (%)'), mutationMinimumHelp: vscode.l10n.t('Zero disables the absolute threshold. A differential gate can still detect degradation above this minimum.'),
    mutationTolerance: vscode.l10n.t('Allowed decrease (percentage points)'), mutationToleranceHelp: vscode.l10n.t('Only technically comparable base and current measurements can demonstrate a decrease.'),
    tagline: vscode.l10n.t('Review · Verify · Deliver'), languageModels: vscode.l10n.t('VS Code Language Models'), compatible: vscode.l10n.t('OpenAI compatible'),
    rights: vscode.l10n.t('All rights reserved except those granted under the MIT License.'),
    comparison: vscode.l10n.t('Compare reviews'), chooseComparison: vscode.l10n.t('Choose a previous review'), clearComparison: vscode.l10n.t('Clear comparison'), comparisonEligibility: vscode.l10n.t('Only reviews with the same repository, scope, branch and base commit can be compared. Historical evidence is never restored as current.'), newFindings: vscode.l10n.t('Newly observed'), persistingFindings: vscode.l10n.t('Still observed'), noLongerObserved: vscode.l10n.t('No longer observed (resolution unproven)'), snapshotUnavailable: vscode.l10n.t('Full snapshot not retained; comparison is unavailable.'), openFinding: vscode.l10n.t('Open finding'), openEvidence: vscode.l10n.t('Open Evidence'), analysisDuration: vscode.l10n.t('Measured analysis duration'), reproducibilityLimitations: vscode.l10n.t('Reproducibility limitations'),
    home: vscode.l10n.t('Home'), review: vscode.l10n.t('Review'), verify: vscode.l10n.t('Verify'), github: vscode.l10n.t('GitHub'), settings: vscode.l10n.t('Settings'), history: vscode.l10n.t('History'),
    workspace: vscode.l10n.t('Workspace'), refresh: vscode.l10n.t('Refresh status'), choose: vscode.l10n.t('Choose repository'), noRepo: vscode.l10n.t('Choose a repository to get started'),
    welcome: vscode.l10n.t('Your review workspace'), welcomeDetail: vscode.l10n.t('Review changes, verify the evidence, and deliver from one place.'),
    start: vscode.l10n.t('Review current changes'), staged: vscode.l10n.t('Review staged changes'), branch: vscode.l10n.t('Review a branch'), commit: vscode.l10n.t('Review a commit'), pr: vscode.l10n.t('Review a pull request'),
    findings: vscode.l10n.t('Findings'), checks: vscode.l10n.t('Checks run'), changes: vscode.l10n.t('Changed files'), risk: vscode.l10n.t('Risk'),
    latest: vscode.l10n.t('Current review'), noReview: vscode.l10n.t('No current review'), noReviewDetail: vscode.l10n.t('Start a review to see findings and prepare verification.'), results: vscode.l10n.t('Open review results'), export: vscode.l10n.t('Export report'),
    gettingStarted: vscode.l10n.t('Set up your workspace'), stepRepo: vscode.l10n.t('Choose your repository'), stepChecks: vscode.l10n.t('Review and approve checks'), stepGithub: vscode.l10n.t('Connect GitHub when you are ready'), stepAi: vscode.l10n.t('Add an AI reviewer (optional)'),
    local: vscode.l10n.t('Local Git actions'), localDetail: vscode.l10n.t('Manage branches, stage files, commit, and push with a preview.'),
    reviewDetail: vscode.l10n.t('Choose the changes to inspect. Local analysis runs without an AI account.'), verifyDetail: vscode.l10n.t('Review detected checks before approving execution. Compare against the base revision to understand regressions.'),
    run: vscode.l10n.t('Choose and run checks'), noChecks: vscode.l10n.t('Checks appear after a review. Nothing runs automatically from this panel.'),
    githubDetail: vscode.l10n.t('Manage your pull request, review conversations, CI, and merge options.'), connect: vscode.l10n.t('Connect GitHub'), disconnected: vscode.l10n.t('GitHub is not connected'), delivery: vscode.l10n.t('Open GitHub delivery'), publish: vscode.l10n.t('Create or update pull request'), status: vscode.l10n.t('Pull request and CI status'), publishReview: vscode.l10n.t('Publish review'), merge: vscode.l10n.t('Review merge options'), repositoryChoice: vscode.l10n.t('Git and GitHub actions let you choose their repository when needed.'), githubSafety: vscode.l10n.t('Publishing and merge actions keep their previews, confirmations, and policy checks.'),
    settingsDetail: vscode.l10n.t('Choose where to save each preference. Credentials are managed separately in secure storage.'), scopeHelp: vscode.l10n.t('Values below belong to the selected scope. Workspace preferences can override User preferences.'), user: vscode.l10n.t('User'), saveTo: vscode.l10n.t('Save preferences to'), advanced: vscode.l10n.t('All Probato settings'), saved: vscode.l10n.t('Preference saved.'),
    onSave: vscode.l10n.t('Review on save'), onSaveDetail: vscode.l10n.t('Re-run an active working-tree review after saved changes.'), baseBranch: vscode.l10n.t('Base branch'), baseDetail: vscode.l10n.t('Leave empty to detect the default branch.'), maxFiles: vscode.l10n.t('Maximum files per review'), baseline: vscode.l10n.t('Baseline verification'), ask: vscode.l10n.t('Ask before comparing'), always: vscode.l10n.t('Always compare'), never: vscode.l10n.t('Do not compare'), timeout: vscode.l10n.t('Check timeout (seconds)'), ai: vscode.l10n.t('AI provider'), none: vscode.l10n.t('Disabled'), include: vscode.l10n.t('Include file content in AI context'), includeDetail: vscode.l10n.t('AI requests can send selected code to your configured provider.'), configureAi: vscode.l10n.t('Configure AI and credentials'), startup: vscode.l10n.t('Open Home on startup'),
    privacy: vscode.l10n.t('Privacy and approvals'), privacyDetail: vscode.l10n.t('Local analysis stays on your machine. AI and GitHub actions use the services you configure.'), forgetChecks: vscode.l10n.t('Reset check approvals'), forgetKeys: vscode.l10n.t('Remove saved AI keys'),
    historyDetail: vscode.l10n.t('Recent review summaries stored locally for this workspace. Older evidence is not restored as current.'), emptyHistory: vscode.l10n.t('Your review history will appear here.'), clear: vscode.l10n.t('Delete local review history'),
    trust: vscode.l10n.t('Trust this workspace before reviewing code or running checks.'), stop: vscode.l10n.t('Cancel operation'), loading: vscode.l10n.t('Loading workspace status…'),
  };
  const serializedLabels = JSON.stringify(labels).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${escapeHtml(vscode.env.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtml(cspSource)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Probato PR</title><style nonce="${nonce}">${HOME_STYLE}</style></head><body>
<div class="shell"><aside><div class="brand"><img class="brand-logo" src="${escapeHtml(logo)}" alt="Probato PR" width="38" height="38"><div>Probato PR<small>${escapeHtml(labels.tagline)}</small></div></div><nav aria-label="Probato PR"></nav><div class="aside-footer"><button data-action="openSettings" class="text-button">${escapeHtml(labels.advanced)}</button><p class="copyright">© 2026 ArmoTuSitio.com.ar<br>${escapeHtml(labels.rights)}</p></div></aside><div class="workspace"><header><div id="repository">${escapeHtml(labels.loading)}</div><div class="header-actions"><button data-action="selectRepository" class="quiet">${escapeHtml(labels.choose)}</button><button data-action="refresh" class="quiet">${escapeHtml(labels.refresh)}</button></div></header><div id="busy" role="status" hidden></div><div id="trust" role="status" hidden>${escapeHtml(labels.trust)}</div><main id="content" tabindex="-1"></main><div id="notice" role="status" aria-live="polite"></div></div></div>
<script nonce="${nonce}">const L=${serializedLabels};${HOME_SCRIPT}</script></body></html>`;
}

const HOME_STYLE = `
:root{color-scheme:light dark;--probato-accent:#2ea98f;--probato-link:#2ea98f;--probato-ink:#14181d}body.vscode-light{--probato-link:#137763}body.vscode-high-contrast,body.vscode-high-contrast-light{--probato-link:var(--vscode-textLink-foreground)}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px/1.55 var(--vscode-font-family)}button,input,select{font:inherit}button{cursor:pointer;color:var(--probato-ink);background:var(--probato-accent);border:1px solid transparent;border-radius:5px;padding:8px 14px;transition:background .12s,transform .12s}button:hover{background:#46bea5}button:active{transform:translateY(1px)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}.shell{display:grid;grid-template-columns:208px minmax(0,1fr);min-height:100vh}aside{background:var(--vscode-sideBar-background);border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;padding:30px 16px;position:sticky;top:0;height:100vh}.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:650;padding:0 9px 28px}.brand small{display:block;font-size:10px;font-weight:400;color:var(--vscode-descriptionForeground);margin-top:2px;white-space:nowrap}.brand-logo{display:block;flex-shrink:0;width:38px;height:38px}nav{display:flex;flex-direction:column;gap:5px}nav button{text-align:left;background:transparent;color:var(--vscode-foreground);padding:10px 13px}nav button:hover{background:var(--vscode-list-hoverBackground)}nav button[aria-current=page]{background:color-mix(in srgb,var(--probato-accent) 16%,var(--vscode-editor-background));color:var(--vscode-foreground);font-weight:600;box-shadow:inset 3px 0 var(--probato-accent)}.copyright{font-size:11px;line-height:1.5;color:var(--vscode-descriptionForeground);margin:18px 0 0}.aside-footer{margin-top:auto;padding-top:24px}.text-button{background:transparent;color:var(--probato-link);padding:4px 0;text-align:left}.text-button:hover{background:transparent;text-decoration:underline}.workspace{min-width:0}header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--vscode-panel-border);padding:19px 32px;min-height:78px}#repository{min-width:0;overflow-wrap:anywhere}#repository small{display:block;color:var(--vscode-descriptionForeground)}.header-actions,.actions{display:flex;flex-wrap:wrap;gap:9px}.quiet{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.quiet:hover{background:var(--vscode-button-secondaryHoverBackground)}main{max-width:1120px;margin:auto;padding:38px 44px 60px;animation:arrive .18s ease-out}h1{font-size:29px;line-height:1.2;letter-spacing:-.5px;font-weight:600;margin:0 0 12px}h2{font-size:17px;font-weight:600;margin:0 0 12px}h3{font-size:13px;font-weight:600;margin:0}.description{color:var(--vscode-descriptionForeground);margin:0 0 24px;max-width:680px}.eyebrow{color:var(--probato-link);text-transform:uppercase;font-size:10px;font-weight:650;letter-spacing:1.5px;margin:0 0 10px}.lead{padding-bottom:30px;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:28px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin:28px 0}.stat strong{display:block;font-size:28px;line-height:1.2;font-weight:550}.stat span{font-size:11px;color:var(--vscode-descriptionForeground)}.columns{display:grid;grid-template-columns:1.2fr 1fr;gap:36px}section+section{margin-top:28px}.comparison-entry{padding:12px 0;border-bottom:1px solid var(--vscode-panel-border)}summary{cursor:pointer}.comparison-entry button{margin-right:8px}.row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 0;border-bottom:1px solid var(--vscode-panel-border)}.row:last-child{border-bottom:0}.row small{display:block;color:var(--vscode-descriptionForeground);margin-top:4px}.step{display:flex;gap:12px;align-items:center;padding:13px 0}.step-index{width:25px;height:25px;border:1px solid var(--vscode-panel-border);border-radius:50%;text-align:center;line-height:23px;color:var(--vscode-descriptionForeground)}.step-index.done{color:var(--vscode-testing-iconPassed);border-color:var(--vscode-testing-iconPassed)}.step button{background:transparent;color:var(--probato-link);padding:0;text-align:left}.muted{color:var(--vscode-descriptionForeground)}.section-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--vscode-descriptionForeground);margin:0 0 16px}.scope-switch{display:flex;align-items:center;gap:12px;margin-bottom:20px}select,input[type=text],input[type=number]{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:7px 9px;max-width:100%}input[type=text]{width:220px}input[type=number]{width:100px}input[type=checkbox]{accent-color:var(--vscode-focusBorder);width:17px;height:17px;cursor:pointer}.field{min-width:110px;max-width:240px}.settings-section{margin-bottom:30px}.empty{padding:20px 0}.empty p{color:var(--vscode-descriptionForeground);max-width:540px}.action-list{display:flex;flex-direction:column;gap:10px;max-width:560px}.action-list button{text-align:left;padding:14px 18px}.check-list{padding-left:20px}.history-item{display:grid;grid-template-columns:1fr auto;gap:12px;padding:17px 0;border-bottom:1px solid var(--vscode-panel-border)}.history-item small{display:block;color:var(--vscode-descriptionForeground)}#notice{position:sticky;bottom:14px;margin:0 32px;min-height:24px;color:var(--vscode-descriptionForeground)}#notice.error{color:var(--vscode-errorForeground)}#busy,#trust{padding:11px 32px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-inactiveSelectionBackground)}#busy button{float:right;padding:1px 9px}body.vscode-high-contrast button,body.vscode-high-contrast-light button{border-color:var(--vscode-contrastBorder)}body.vscode-high-contrast button:not(.quiet):not(.text-button),body.vscode-high-contrast-light button:not(.quiet):not(.text-button){color:var(--vscode-button-foreground);background:var(--vscode-button-background)}body.vscode-high-contrast .text-button,body.vscode-high-contrast-light .text-button{color:var(--vscode-textLink-foreground)}@keyframes arrive{from{opacity:.5;transform:translateY(4px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}@media(max-width:850px){.shell{grid-template-columns:165px minmax(0,1fr)}aside{padding:25px 10px}.brand{font-size:14px;gap:7px}.brand small{font-size:8px}main{padding:28px 24px}.columns{grid-template-columns:1fr;gap:25px}header{padding:16px 24px;align-items:flex-start}.header-actions{justify-content:flex-end}.header-actions button{font-size:11px;padding:6px 9px}}@media(max-width:580px){.shell{display:block}aside{height:auto;position:static;padding:18px 16px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.brand{padding-bottom:15px}.brand small{font-size:10px}nav{display:flex;flex-direction:row;overflow:auto;gap:4px}nav button{padding:7px 11px;white-space:nowrap}.aside-footer{display:none}header{padding:15px 20px;flex-direction:column;gap:10px}.header-actions{justify-content:flex-start}main{padding:25px 20px}.stats{gap:10px}.stat strong{font-size:23px}.row{align-items:flex-start;flex-wrap:wrap}.field{max-width:100%}h1{font-size:25px}}
`;

const HOME_SCRIPT = String.raw`
const vscode=acquireVsCodeApi();
const sections=['home','review','verify','github','settings','history'];
const persisted=vscode.getState()||{};
let section=sections.includes(persisted.section)?persisted.section:'home';
let target=persisted.target==='workspace'?'workspace':'user';
let state;
const content=document.getElementById('content');
function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node;}
function send(action){vscode.postMessage({type:'action',action});}
function button(label,action,primary=false,needsReview=false){const b=element('button',label,primary?'':'quiet');b.type='button';b.addEventListener('click',()=>send(action));b.disabled=Boolean(state&&state.busy)||Boolean(needsReview&&(!state||!state.review));if(action==='mutationTesting'&&(!state||!state.review||!state.review.hasLocalCheckout))b.disabled=true;if(['reviewCurrentChanges','reviewStagedChanges','reviewBranch','reviewCommit','verify'].includes(action)&&state&&(!state.trusted||!state.repository))b.disabled=true;return b;}
function actions(parent,items){const node=element('div',undefined,'actions');items.forEach(item=>node.append(button(...item)));parent.append(node);}
function heading(title,description){content.append(element('h1',title),element('p',description,'description'));}
function nav(){const n=document.querySelector('nav');n.replaceChildren();sections.forEach(key=>{const b=element('button',L[key]);b.setAttribute('aria-current',key===section?'page':'false');b.addEventListener('click',()=>navigate(key,true));n.append(b);});}
function navigate(next,focus=false){section=next;vscode.setState({section,target});vscode.postMessage({type:'navigate',section});nav();render();if(focus)content.focus();}
function sectionHeading(parent,title){parent.append(element('h2',title));}
function currentReview(parent){sectionHeading(parent,L.latest);if(!state.review){const empty=element('div',undefined,'empty');empty.append(element('h3',L.noReview),element('p',L.noReviewDetail));parent.append(empty);return;}const r=state.review;parent.append(element('p',r.repository+' · '+r.scope,'muted'));const stats=element('div',undefined,'stats');[[r.findings,L.findings],[r.checks,L.checks],[r.risk,L.risk]].forEach(([v,label])=>{const s=element('div',undefined,'stat');s.append(element('strong',v),element('span',label));stats.append(s);});parent.append(stats);if(r.analysisMs!==undefined)parent.append(element('p',L.analysisDuration+': '+r.analysisMs.toFixed(0)+' ms','muted'));if(r.reproducibilityLimitations&&r.reproducibilityLimitations.length){parent.append(element('h3',L.reproducibilityLimitations));const reasons=element('ul');r.reproducibilityLimitations.forEach(reason=>reasons.append(element('li',reason)));parent.append(reasons);}actions(parent,[[L.results,'showResults',true,true],[L.export,'exportReport',false,true]]);}
function compareSection(parent){const block=element('section');sectionHeading(block,L.comparison);block.append(element('p',L.comparisonEligibility,'muted'));const chooser=element('select');chooser.setAttribute('aria-label',L.chooseComparison);const placeholder=element('option',L.chooseComparison);placeholder.value='';chooser.append(placeholder);(state.comparisonOptions||[]).forEach(candidate=>{const option=element('option',candidate.label);option.value=candidate.id;chooser.append(option);});chooser.value=state.comparison?state.comparison.previousId:'';chooser.disabled=Boolean(state.busy)||!(state.comparisonOptions&&state.comparisonOptions.length);chooser.addEventListener('change',()=>{if(chooser.value)vscode.postMessage({type:'compareReview',id:chooser.value});});block.append(chooser);const comparison=state.comparison;if(comparison){const clear=element('button',L.clearComparison,'quiet');clear.addEventListener('click',()=>vscode.postMessage({type:'clearComparison'}));block.append(clear);if(comparison.reason)block.append(element('p',comparison.reason,'muted'));if(comparison.comparable){block.append(element('p',L.newFindings+': '+comparison.counts.new+' · '+L.persistingFindings+': '+comparison.counts.persisting+' · '+L.noLongerObserved+': '+comparison.counts['no-longer-observed']));comparison.entries.forEach(entry=>{const detail=element('details',undefined,'comparison-entry');detail.append(element('summary',entry.label+' · '+entry.title+' · '+entry.file+':'+entry.line),element('p',entry.note,'muted'));if(entry.currentFindingId){const open=element('button',L.openFinding,'quiet');open.addEventListener('click',()=>vscode.postMessage({type:'openComparisonFinding',id:entry.currentFindingId}));detail.append(open);}if(entry.passedCheckEvidenceId){const evidence=element('button',L.openEvidence,'quiet');evidence.addEventListener('click',()=>vscode.postMessage({type:'openComparisonEvidence',id:entry.passedCheckEvidenceId}));detail.append(evidence);}block.append(detail);});}}parent.append(block);}
function setup(parent){sectionHeading(parent,L.gettingStarted);[[L.stepRepo,'selectRepository',!!state.repository],[L.stepChecks,'verify',!!state.review&&state.review.checks>0],[L.stepGithub,'connectGitHub',!!state.github],[L.stepAi,'connectAi',state.settings['ai.provider']!=='none']].forEach(([label,action,done],i)=>{const row=element('div',undefined,'step');row.append(element('span',done?'✓':i+1,'step-index'+(done?' done':'')));row.append(button(label,action,false,action==='verify'));parent.append(row);});}
function render(){if(!state)return;content.replaceChildren();if(section==='home'){const lead=element('div',undefined,'lead');lead.append(element('p','Probato PR','eyebrow'),element('h1',L.welcome),element('p',L.welcomeDetail,'description'));actions(lead,[[state.repository?L.start:L.choose,state.repository?'reviewCurrentChanges':'selectRepository',true],[L.local,'localGit']]);content.append(lead);if(state.repository){const stats=element('div',undefined,'stats');const s=element('div',undefined,'stat');s.append(element('strong',state.repository.changes),element('span',L.changes));stats.append(s);content.append(stats);}const cols=element('div',undefined,'columns');const left=element('section');currentReview(left);const right=element('section');setup(right);cols.append(left,right);content.append(cols);if(state.review)compareSection(content);}
else if(section==='review'){heading(L.review,L.reviewDetail);const list=element('div',undefined,'action-list');[[L.start,'reviewCurrentChanges'],[L.staged,'reviewStagedChanges'],[L.branch,'reviewBranch'],[L.commit,'reviewCommit'],[L.pr,'reviewPullRequest']].forEach((item,i)=>list.append(button(item[0],item[1],i===0)));content.append(list);const latest=element('section');currentReview(latest);content.append(latest);}
else if(section==='verify'){heading(L.verify,L.verifyDetail);if(state.review)content.append(element('p',state.review.repository+' · '+state.review.scope,'muted'));actions(content,[[L.run,'verify',true,true],[L.results,'showResults',false,true]]);if(state.checks.length){const list=element('ul',undefined,'check-list');state.checks.forEach(check=>list.append(element('li',check.title||check.id)));content.append(list);}else content.append(element('p',L.noChecks,'muted'));const mutation=element('section');renderMutation(mutation);content.append(mutation);const privacy=element('section');sectionHeading(privacy,L.privacy);privacy.append(element('p',L.privacyDetail,'muted'));actions(privacy,[[L.forgetChecks,'forgetApprovedChecks']]);content.append(privacy);}
else if(section==='github'){heading(L.github,L.githubDetail);content.append(element('p',state.github||L.disconnected,'muted'));actions(content,[[state.github?L.delivery:L.connect,state.github?'delivery':'connectGitHub',true],[L.pr,'reviewPullRequest']]);const list=element('section',undefined,'action-list');[[L.publish,'publishPullRequest'],[L.status,'pullRequestStatus'],[L.publishReview,'publishReview'],[L.merge,'mergePullRequest']].forEach(item=>list.append(button(item[0],item[1],false,item[1]==='publishReview')));content.append(list,element('p',L.githubSafety,'muted'),element('p',L.repositoryChoice,'muted'));}
else if(section==='settings')renderSettings();
else{heading(L.history,L.historyDetail);if(!state.history.length)content.append(element('p',L.emptyHistory,'muted'));state.history.forEach(entry=>{const row=element('div',undefined,'history-item');const info=element('div');info.append(element('h3',entry.repository),element('small',entry.scope+' · '+new Date(entry.createdAt).toLocaleString()));row.append(info,element('span',entry.findings+' '+L.findings.toLowerCase()+' · '+entry.risk,'muted'));if((state.comparisonOptions||[]).some(candidate=>candidate.id===entry.id)){const compare=element('button',L.comparison,'quiet');compare.disabled=Boolean(state.busy);compare.addEventListener('click',()=>vscode.postMessage({type:'compareReview',id:entry.id}));row.append(compare);}else if(!entry.snapshotAvailable)info.append(element('small',L.snapshotUnavailable));content.append(row);});if(state.review)compareSection(content);const footer=element('section');actions(footer,[[L.clear,'clearHistory']]);content.append(footer);}}
function renderMutation(parent){sectionHeading(parent,L.mutationTitle);parent.append(element('p',L.mutationOptional,'muted'));actions(parent,[[L.mutationRun,'mutationTesting',false,true]]);const m=state.mutation;if(!m)return;parent.append(element('p',L.mutationMetricHelp,'muted'));[[L.mutationExecution,m.execution],[L.mutationVerification,m.verification],[L.mutationQuality,m.quality],[L.mutationGate,m.gate],[L.mutationBaseline,m.baseline]].forEach(([label,axis])=>{const row=element('div',undefined,'row');row.append(element('strong',label),element('span',axis.label+' · '+axis.value));parent.append(row);});const reasons=[...new Set([...m.verification.reasons,...m.baseline.reasons,...m.quality.reasons,...m.gate.reasons])];if(reasons.length){const list=element('ul');reasons.forEach(reason=>list.append(element('li',reason)));parent.append(list);}if(m.quality.deltaPoints!==undefined)parent.append(element('p',L.mutationDelta+': '+(m.quality.deltaPoints>0?'+':'')+m.quality.deltaPoints));m.runs.forEach(run=>{const block=element('section');sectionHeading(block,run.label);if(run.score!==undefined)block.append(element('p',L.mutationScore+': '+run.score+'%'));if(run.killedOnlyScore!==undefined)block.append(element('p',L.mutationKilledOnly+': '+run.killedOnlyScore+'%','muted'));run.context.forEach(line=>block.append(element('small',line,'muted')));parent.append(block);});actions(parent,[[L.results,'showResults',false,true],[L.export,'exportReport',false,true]]);}
function setting(parent,key,label,help,type,options){const values=(target==='workspace'?state.workspaceSettings:state.userSettings)||state.settings;const row=element('div',undefined,'row');const info=element('div');const id='setting-'+key;const title=element('label',label);title.htmlFor=id;info.append(title);if(help)info.append(element('small',help));let field;if(type==='select'){field=element('select');options.forEach(([value,text])=>{const option=element('option',text);option.value=value;field.append(option);});field.value=String(values[key]??'');}else{field=element('input');field.type=type;if(type==='checkbox')field.checked=Boolean(values[key]);else field.value=String(values[key]??'');if(type==='number'){const limits={'review.maxFiles':[1,5000],'verification.timeoutSeconds':[5,7200],'mutation.timeoutSeconds':[5,7200],'mutation.concurrency':[1,8],'mutation.memoryMb':[256,8192],'mutation.maxFiles':[1,100],'mutation.minimumScore':[0,100],'mutation.tolerancePoints':[0,100]}[key]||[0,100];field.min=String(limits[0]);field.max=String(limits[1]);field.step=['mutation.minimumScore','mutation.tolerancePoints'].includes(key)?'any':'1';}if(type==='text')field.maxLength=200;}field.id=id;field.className='field';field.disabled=Boolean(state.busy);field.addEventListener('change',()=>{if(!field.reportValidity())return;const value=type==='checkbox'?field.checked:type==='number'?Number(field.value):field.value;vscode.postMessage({type:'setting',key,value,target});});row.append(info,field);parent.append(row);}
function renderSettings(){heading(L.settings,L.settingsDetail);const scope=element('div',undefined,'scope-switch');const label=element('label',L.saveTo);label.htmlFor='target';const select=element('select');select.id='target';[['user',L.user],['workspace',L.workspace]].forEach(([value,text])=>{const o=element('option',text);o.value=value;select.append(o);});select.value=target;select.addEventListener('change',()=>{target=select.value;vscode.setState({section,target});render();document.getElementById('target').focus();});scope.append(label,select);content.append(scope,element('p',L.scopeHelp,'description'));const review=element('section',undefined,'settings-section');sectionHeading(review,L.review);setting(review,'review.onSave',L.onSave,L.onSaveDetail,'checkbox');setting(review,'review.baseBranch',L.baseBranch,L.baseDetail,'text');setting(review,'review.maxFiles',L.maxFiles,'','number');content.append(review);const verify=element('section',undefined,'settings-section');sectionHeading(verify,L.verify);setting(verify,'verification.baseline',L.baseline,'','select',[['ask',L.ask],['always',L.always],['never',L.never]]);setting(verify,'verification.timeoutSeconds',L.timeout,'','number');content.append(verify);const mutation=element('section',undefined,'settings-section');sectionHeading(mutation,L.mutationTitle);mutation.append(element('p',L.mutationOptional,'muted'));setting(mutation,'mutation.timeoutSeconds',L.mutationTimeout,L.mutationTimeoutHelp,'number');setting(mutation,'mutation.concurrency',L.mutationConcurrency,'','number');setting(mutation,'mutation.memoryMb',L.mutationMemory,'','number');setting(mutation,'mutation.maxFiles',L.mutationFiles,'','number');setting(mutation,'mutation.gateEnabled',L.mutationGateEnabled,L.mutationGateHelp,'checkbox');setting(mutation,'mutation.failOnDegradation',L.mutationFailDegradation,'','checkbox');setting(mutation,'mutation.minimumScore',L.mutationMinimum,L.mutationMinimumHelp,'number');setting(mutation,'mutation.tolerancePoints',L.mutationTolerance,L.mutationToleranceHelp,'number');content.append(mutation);const ai=element('section',undefined,'settings-section');sectionHeading(ai,L.ai);setting(ai,'ai.provider',L.ai,'','select',[['none',L.none],['vscode-lm',L.languageModels],['anthropic','Anthropic'],['openai-compatible',L.compatible]]);setting(ai,'ai.includeFileContent',L.include,L.includeDetail,'checkbox');actions(ai,[[L.configureAi,'connectAi'],[L.forgetKeys,'forgetAiKeys']]);content.append(ai);const general=element('section',undefined,'settings-section');setting(general,'home.openOnStartup',L.startup,'','checkbox');actions(general,[[L.advanced,'openSettings']]);content.append(general);}
document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>send(b.dataset.action)));
window.addEventListener('message',event=>{const message=event.data;if(message.type==='navigate'&&sections.includes(message.section)){navigate(message.section);return;}if(message.type==='notice'){const n=document.getElementById('notice');n.textContent=message.text;n.className=message.error?'error':'';if(message.loadError&&!state){document.getElementById('repository').textContent=message.text;content.replaceChildren(element('h1',L.home),element('p',message.text,'description'),button(L.refresh,'refresh',true));}return;}if(message.type!=='state')return;state=message.state;const repo=document.getElementById('repository');repo.replaceChildren(element('strong',state.repository?state.repository.name:L.noRepo));if(state.repository)repo.append(element('small',state.repository.branch+' · '+state.repository.changes+' '+L.changes.toLowerCase()));const busy=document.getElementById('busy');busy.hidden=!state.busy;busy.replaceChildren();if(state.busy){busy.append(element('span',state.busy),button(L.stop,'cancel'));busy.querySelector('button').disabled=false;}document.getElementById('trust').hidden=state.trusted;const focused=document.activeElement;const id=focused&&focused.id;render();if(id){const replacement=document.getElementById(id);if(replacement)replacement.focus();}});
nav();vscode.postMessage({type:'ready',section});
`;
