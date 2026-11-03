import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildAiContext } from '../ai/ai-context';
import { AiProviderError, type AIReviewProvider } from '../ai/ai-provider';
import { InvalidBaseUrlError } from '../ai/openai-compatible-provider';
import { parseAiReview } from '../ai/ai-response';
import { EMPTY_WORKSPACE, type WorkspaceIndex } from '../core/analyzer';
import type { ChangeSet, PlannedCheck, ReviewResult } from '../core/model';
import { checkKindLabel } from '../core/labels';
import { isWithin, PathOutsideWorkspaceError, resolveInside } from '../core/paths';
import { finalizeResult, type ProgressReporter, type ReviewEngine } from '../core/review-engine';
import { CancelledError, GitError, GitNotFoundError, OutputTooLargeError, type GitClient } from '../git/git-client';
import { assertReviewCurrent, repositorySnapshot } from '../git/repository-snapshot';
import { LocalChangeCollector, NoChangesError, type LocalReviewRequest } from '../git/local-changes';
import { GitHubError, parseGitHubRemote, type GitHubClient } from '../github/github-client';
import { pullRequestChangeSet } from '../github/pull-request-changes';
import { RevisionWorkspaceIndex } from '../infrastructure/revision-workspace-index';
import { importSarif } from '../reports/sarif-import';
import { GitWorkspaceIndex } from '../infrastructure/workspace-index';
import { renderJson } from '../reports/json';
import { renderMarkdown, renderPullRequestDescription } from '../reports/markdown';
import { renderSarif } from '../reports/sarif';
import { evidenceUri, REPORT_URI } from '../ui/documents';
import type { ApprovedChecks } from '../verification/approved-checks';
import { detectMonorepoChecks } from '../verification/monorepo-checks';
import { ReviewedWorktree } from '../verification/review-worktree';
import type { VerificationEngine } from '../verification/verification-engine';
import { BusyError, type ReviewSession } from './review-session';
import { ensureSavedRepository } from './review-state';
import type { Settings } from './settings';

export interface ControllerDeps {
  readonly session: ReviewSession;
  readonly git: GitClient;
  readonly engine: ReviewEngine;
  readonly verification: VerificationEngine;
  /** Checks the user chose to run without being asked again, per repository. */
  readonly approvals: ApprovedChecks;
  readonly github: GitHubClient;
  readonly signInToGitHub: () => Promise<boolean>;
  readonly aiProvider: () => AIReviewProvider | undefined;
  readonly settings: () => Settings & { readonly maxFileBytes: number };
  readonly log: vscode.LogOutputChannel;
  /** Opens (or reveals) the Review Summary panel. */
  readonly showSummary: (preserveFocus?: boolean) => void;
  /** Runs the "Connect your AI" setup. */
  readonly connectAi: () => Promise<void>;
}

/** Orchestrates user commands. All operations are read-only unless the user approves otherwise. */
export class ReviewController {
  private lastChanges: ChangeSet | undefined;
  private lastReviewId: string | undefined;
  private lastRepo: string | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  // ---------------------------------------------------------------- reviews

  /** `target` (optional) selects the repository, e.g. from the Source Control view or in multi-root workspaces. */
  reviewLocal(kind: 'working' | 'staged', target?: vscode.Uri): Promise<void> {
    return this.run(vscode.l10n.t('Reviewing changes'), async (signal, root, report) => {
      await this.reviewWith(root, { kind }, signal, report);
    }, target);
  }

  reviewBranch(target?: vscode.Uri): Promise<void> {
    return this.run(vscode.l10n.t('Reviewing branch'), async (signal, root, report) => {
      const configured = this.deps.settings().review.baseBranch;
      let base = await this.deps.git.defaultBaseBranch(root, configured);
      if (!base) {
        base = await vscode.window.showInputBox({
          title: vscode.l10n.t('Base branch'),
          prompt: vscode.l10n.t('No base branch detected (origin/HEAD, main, master). Enter the branch or ref to compare against.'),
          placeHolder: 'origin/main',
          ignoreFocusOut: true,
        });
        if (!base) {
          return;
        }
      }
      await this.reviewWith(root, { kind: 'branch', baseBranch: base.trim() }, signal, report);
    }, target);
  }

  reviewCommit(target?: vscode.Uri): Promise<void> {
    return this.run(vscode.l10n.t('Reviewing commit'), async (signal, root, report) => {
      const ref = await vscode.window.showInputBox({ title: vscode.l10n.t('Commit to review'), value: 'HEAD', prompt: vscode.l10n.t('A commit SHA, tag or ref'), ignoreFocusOut: true });
      if (!ref) {
        return;
      }
      await this.reviewWith(root, { kind: 'commit', ref: ref.trim() }, signal, report);
    }, target);
  }

  private async reviewWith(root: string, request: LocalReviewRequest, signal: AbortSignal, report: ProgressReporter): Promise<void> {
    const settings = this.deps.settings();
    const limits = { ...settings.review, maxFileBytes: settings.maxFileBytes };
    ensureSavedRepository(root);
    const snapshot = await repositorySnapshot(this.deps.git, root, signal);
    const changes = await new LocalChangeCollector(this.deps.git).collect(root, request, limits, signal);
    const workspace = request.kind === 'working'
      ? new GitWorkspaceIndex(this.deps.git, root, settings.maxFileBytes)
      : new RevisionWorkspaceIndex(this.deps.git, root, request.kind === 'staged' ? '' : changes.scope.headSha ?? 'HEAD', settings.maxFileBytes);
    await this.analyze(changes, workspace, signal, report, snapshot.fingerprint);
  }

  reviewPullRequest(): Promise<void> {
    return this.run(vscode.l10n.t('Reviewing pull request'), async (signal, root, report) => {
      const remote = await this.deps.git.remoteUrl(root);
      const ref = remote ? parseGitHubRemote(remote) : undefined;
      if (!ref) {
        void vscode.window.showWarningMessage(vscode.l10n.t('The "origin" remote of this repository is not on github.com. Pull request review currently supports GitHub only; local reviews work for any repository.'));
        return;
      }
      const pulls = await this.withGitHubAuth(() => this.deps.github.listOpenPulls(ref, signal));
      if (!pulls) {
        return;
      }
      if (pulls.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('{0}/{1} has no open pull requests.', ref.owner, ref.repo));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        pulls.map((p) => ({ label: `#${p.number} ${p.title}`, description: `${p.head.ref} → ${p.base.ref}`, detail: p.user?.login ?? '', pull: p })),
        { title: vscode.l10n.t('Select a pull request to review'), matchOnDescription: true },
      );
      if (!picked) {
        return;
      }
      const settings = this.deps.settings();
      const headSha = await this.deps.git.resolveCommit(root, 'HEAD');
      // Repository files are only usable as context when the local checkout is exactly the PR head.
      const snapshot = await repositorySnapshot(this.deps.git, root, signal);
      const localMatchesHead = headSha === picked.pull.head.sha && !snapshot.dirty;
      const changes = await pullRequestChangeSet(
        this.deps.github,
        ref,
        picked.pull,
        { ...settings.review, maxFileBytes: settings.maxFileBytes },
        { name: `${ref.owner}/${ref.repo}`, root: localMatchesHead ? root : '', branch: picked.pull.head.ref, headSha: picked.pull.head.sha },
        signal,
      );
      const workspace: WorkspaceIndex = localMatchesHead ? new GitWorkspaceIndex(this.deps.git, root, settings.maxFileBytes) : EMPTY_WORKSPACE;
      await this.analyze(changes, workspace, signal, report, localMatchesHead ? snapshot.fingerprint : undefined);
      if (!localMatchesHead) {
        this.deps.log.info(`PR #${picked.pull.number}: local HEAD ${headSha ?? 'none'} differs from PR head ${picked.pull.head.sha}; verification and cross-file analysis disabled.`);
      }
    });
  }

  private async analyze(changes: ChangeSet, workspace: WorkspaceIndex, signal: AbortSignal, report: ProgressReporter, snapshot?: string): Promise<void> {
    const review = await this.deps.engine.review(changes, workspace, { signal, progress: report });
    if (signal.aborted) {
      throw new CancelledError();
    }
    if (snapshot && (await repositorySnapshot(this.deps.git, changes.repository.root, signal)).fingerprint !== snapshot) {
      throw new Error(vscode.l10n.t('Repository content changed during review. Run the review again.'));
    }
    this.lastChanges = changes;
    this.lastReviewId = review.id;
    this.deps.session.setReview({ ...review, ...(snapshot ? { snapshot } : {}) });
    if (changes.repository.root && changes.scope.headIsWorkingTree) {
      this.deps.session.setPlan(await this.planChecks(changes.repository.root));
    }
    this.deps.log.info(`Review ${review.id}: ${review.findings.length} finding(s), risk ${review.risk.level}, ${review.stats.filesChanged} file(s).`);
    await vscode.commands.executeCommand('probatoPR.findings.focus');
    this.deps.showSummary();
  }

  private async planChecks(root: string): Promise<PlannedCheck[]> {
    const snapshot = await repositorySnapshot(this.deps.git, root);
    return detectMonorepoChecks(root, process.platform, snapshot.fingerprint);
  }

  // ---------------------------------------------------------------- verification

  verify(): Promise<void> {
    return this.guarded(async () => {
      const review = this.deps.session.base;
      if (!review) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Run a review first.'));
        return;
      }
      const root = review.repository.root;
      if (!root) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Verification runs project checks locally, so it needs the pull request head checked out (for example with "gh pr checkout"). Then review the pull request again.'));
        return;
      }
      ensureSavedRepository(root);
      await assertReviewCurrent(this.deps.git, review, undefined, false);
      await this.exclusiveWithProgress(vscode.l10n.t('Running verification'), vscode.ProgressLocation.Notification, 'Probato PR', async (signal, report) => {
        if (this.currentReviewId() !== review.id) throw new Error(vscode.l10n.t('The active review changed. Run this action again.'));
        let isolated: ReviewedWorktree | undefined;
        try {
          if (!review.scope.headIsWorkingTree) isolated = await ReviewedWorktree.create(this.deps.git, root, review.scope);
          const executionRoot = isolated?.directory ?? root;
          const plan = await detectMonorepoChecks(executionRoot, process.platform, review.snapshot, undefined, root);
          await isolated?.linkDependencies(plan.map((check) => check.cwd));
          this.deps.session.setPlan(plan);
          if (!plan.length) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No verification tools detected in the reviewed project.'));
            return;
          }
          const approved = await this.approveChecks(root, plan);
          if (!approved) return;
          const baselineCommit = await this.chooseBaseline(review);
          ensureSavedRepository(root);
          await assertReviewCurrent(this.deps.git, review, signal, false);
          const settings = this.deps.settings();
          const outcome = await this.deps.verification.run({
            repoRoot: executionRoot, dependencyRoot: root, approved, baselineCommit,
            headSha: review.scope.headSha ?? review.repository.headSha,
            headDirty: review.scope.headIsWorkingTree || review.scope.kind === 'staged',
            timeoutMs: settings.verification.timeoutSeconds * 1000,
            maxOutputBytes: settings.verification.maxOutputBytes,
            signal, progress: report,
          });
          for (const e of outcome.evidence) this.deps.log.info(`[evidence ${e.id}] ${e.revision} ${e.commandLine} -> ${e.outcome}`);
          if (outcome.baselineError) this.deps.log.warn(outcome.baselineError);
          ensureSavedRepository(root);
          try { await assertReviewCurrent(this.deps.git, review, signal.aborted ? undefined : signal, false); }
          catch (error) { this.deps.session.invalidate(); throw error; }
          if (this.currentReviewId() !== review.id) throw new Error(vscode.l10n.t('The active review changed. Run this action again.'));
          this.deps.session.setVerification(outcome);
        } finally { await isolated?.dispose(); }
      });
      this.deps.showSummary(true);
    });
  }

  /**
   * Checks remembered for this repository run without asking while their command and script are unchanged.
   * Otherwise the user picks and confirms, and may choose to be remembered.
   */
  private async approveChecks(root: string, plan: readonly PlannedCheck[]): Promise<readonly PlannedCheck[] | undefined> {
    const { approved, changed } = this.deps.approvals.match(root, plan);
    if (changed.length > 0) {
      await this.deps.approvals.forget(root);
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} changed since you approved it, so Probato PR asks again before running anything.', changed.map((c) => c.label).join(', ')),
      );
    } else if (approved.length > 0) {
      const forget = vscode.l10n.t('Forget');
      void vscode.window
        .showInformationMessage(vscode.l10n.t('Running the checks you approved for this exact repository state: {0}.', approved.map((c) => c.label).join(', ')), forget)
        .then(async (answer) => {
          if (answer === forget) {
            await this.deps.approvals.forget(root);
          }
        });
      return approved;
    }
    const items = plan.map((check) => ({
      label: check.label,
      description: checkKindLabel(check.kind),
      detail: [...check.warnings, ...check.requires.map((r) => vscode.l10n.t('May require: {0}', r))].join(' · '),
      // Pre-select only checks that do not run repository code; everything else is an explicit opt-in.
      picked: !check.runsRepositoryCode,
      check,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t('Probato PR: select the checks to run'),
      placeHolder: vscode.l10n.t('Commands run locally with your user permissions. They are not sandboxed.'),
      ignoreFocusOut: true,
    });
    if (!picked || picked.length === 0) {
      return undefined;
    }
    const commands = picked.map((p) => `• ${p.check.label}  (${p.check.command.executable} ${p.check.command.args.join(' ')})`).join('\n');
    const confirm = vscode.l10n.t('Run');
    const remember = vscode.l10n.t('Run and remember');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Run {0} command(s) in this repository?', picked.length),
      {
        modal: true,
        detail: `${commands}\n\n${vscode.l10n.t('They execute with your normal user permissions (no sandbox). Repository scripts are untrusted code: review them before running.')}\n\n${vscode.l10n.t('"Run and remember" applies only while the repository content, commands and configuration remain unchanged.')}`,
      },
      confirm,
      remember,
    );
    const checks = picked.map((p) => p.check);
    if (answer === remember) {
      await this.deps.approvals.remember(root, checks);
    }
    return answer === confirm || answer === remember ? checks : undefined;
  }

  async forgetApprovedChecks(): Promise<void> {
    const count = await this.deps.approvals.forgetAll();
    void vscode.window.showInformationMessage(
      count > 0 ? vscode.l10n.t('Probato PR will ask again before running checks in {0} repository(ies).', count) : vscode.l10n.t('There are no remembered checks.'),
    );
  }

  private async chooseBaseline(review: ReviewResult): Promise<string | undefined> {
    const base = review.scope.baseSha;
    const mode = this.deps.settings().verification.baseline;
    if (!base || mode === 'never') {
      return undefined;
    }
    if (mode === 'always') {
      return base;
    }
    const yes = vscode.l10n.t('Compare with base');
    const always = vscode.l10n.t('Always compare');
    const no = vscode.l10n.t('Head only');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('If a check fails, re-run it on the base revision ({0}) to tell new failures from existing ones?', base.slice(0, 10)),
      {
        modal: true,
        detail: `${vscode.l10n.t('A temporary git worktree is created outside your repository and removed afterwards. Your working tree is not modified.')}\n\n${vscode.l10n.t('"Always compare" saves this choice in your user settings (Probato PR › Verification: Baseline).')}`,
      },
      yes,
      always,
      no,
    );
    if (answer === always) {
      await vscode.workspace.getConfiguration('probatoPR').update('verification.baseline', 'always', vscode.ConfigurationTarget.Global);
    }
    return answer === yes || answer === always ? base : undefined;
  }

  // ---------------------------------------------------------------- AI

  aiReview(): Promise<void> {
    return this.guarded(async () => {
      const review = this.deps.session.base;
      const changes = this.lastChanges;
      if (!review || !changes || this.lastReviewId !== review.id) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Run a review in this session first; AI review uses the same diff.'));
        return;
      }
      let provider = this.deps.aiProvider();
      if (!provider) {
        const message = vscode.l10n.t('Connect GitHub Copilot, Claude, OpenAI or a local model to add an AI reviewer and a pull request summary. It is optional: deterministic review and verification work without it.');
        provider = (await this.offerAiSetup(message, 'info')) ? this.deps.aiProvider() : undefined;
        if (!provider) {
          return;
        }
      }
      if (!(await provider.isAvailable())) {
        await this.offerAiSetup(vscode.l10n.t('{0} is not ready: no model selected, no API key or no signed-in chat model.', provider.name), 'warning');
        return;
      }
      const settings = this.deps.settings();
      await this.ensureCurrentResult(review);
      const context = await buildAiContext(changes, {
        exclude: settings.ai.exclude,
        maxChars: settings.ai.maxContextChars,
        includeFileContent: settings.ai.includeFileContent,
        knownFindings: review.findings,
      });
      if (context.sharedFiles.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to send: every changed file is excluded, sensitive or binary.'));
        return;
      }
      const send = vscode.l10n.t('Send to AI');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Send this change ({0} file(s), {1} characters) to {2}?', context.sharedFiles.length, context.characters, provider.destination),
        {
          modal: true,
          detail: [
            vscode.l10n.t('Diffs: {0}', context.sharedFiles.join(', ')),
            context.contentFiles.length > 0 ? vscode.l10n.t('Full file content, for context: {0}', context.contentFiles.join(', ')) : '',
            context.excluded.length > 0 ? vscode.l10n.t('Not sent: {0}', context.excluded.map((e) => `${e.path} (${e.reason})`).join(', ')) : '',
            vscode.l10n.t('Detected secrets are redacted and sensitive files are never sent. AI findings stay suspected until a check proves them.'),
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        send,
      );
      if (answer !== send) {
        return;
      }
      await this.exclusiveWithProgress(vscode.l10n.t('AI review'), vscode.ProgressLocation.Notification, vscode.l10n.t('Probato PR: AI review'), async (signal) => {
        const startedAt = new Date().toISOString();
        await this.ensureCurrentResult(review, signal);
        const response = await provider.complete(context.prompt, signal);
        await this.ensureCurrentResult(review, signal);
        const parsed = parseAiReview(response.text, changes, context.sharedFiles, `${provider.name} (${response.model})`);
        parsed.rejected.forEach((r) => {
          this.deps.log.info(`AI output rejected: ${r}`);
        });
        const current = this.deps.session.base ?? review;
        this.deps.session.updateReview(
          finalizeResult({
            ...current,
            findings: [...current.findings.filter((f) => f.origin !== 'ai'), ...parsed.accepted],
            ...(parsed.summary ? { aiSummary: parsed.summary } : {}),
            aiRuns: [
              ...current.aiRuns,
              {
                providerId: provider.id,
                model: response.model,
                startedAt,
                filesShared: context.sharedFiles,
                accepted: parsed.accepted.length,
                rejected: parsed.rejected.length,
                rejectionReasons: parsed.rejected,
              },
            ],
          }),
        );
        vscode.window.setStatusBarMessage(vscode.l10n.t('Probato PR: AI suggested {0} finding(s), rejected {1}', parsed.accepted.length, parsed.rejected.length), 8000);
      });
      this.deps.showSummary(true);
    });
  }

  /** Shows a message with a "Connect Your AI" button; returns true when the user ran the setup. */
  private async offerAiSetup(message: string, level: 'info' | 'warning'): Promise<boolean> {
    const connect = vscode.l10n.t('Connect Your AI');
    const show = level === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    if ((await show(message, connect)) !== connect) {
      return false;
    }
    await this.deps.connectAi();
    return true;
  }

  /** Copies a pull request description (AI walkthrough when available + what Probato PR verified). */
  async copyPullRequestDescription(): Promise<void> {
    const review = this.deps.session.current;
    if (!review) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No review yet. Run "Probato PR: Review Current Changes".'));
      return;
    }
    try { await this.ensureCurrentResult(review); } catch (error) { await this.report(error); return; }
    await vscode.env.clipboard.writeText(renderPullRequestDescription(review));
    const hint = review.aiSummary ? '' : ` ${vscode.l10n.t('Run AI Review to add a written summary of the change.')}`;
    void vscode.window.showInformationMessage(`${vscode.l10n.t('Pull request description copied to the clipboard.')}${hint}`);
  }

  importExternalReport(): Promise<void> {
    return this.guarded(async () => {
      const review = this.deps.session.base;
      if (!review) return;
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SARIF: ['sarif', 'json'] }, title: vscode.l10n.t('Import SARIF evidence') });
      const uri = chosen?.[0];
      if (!uri || uri.scheme !== 'file') return;
      if ((await stat(uri.fsPath)).size > 20_000_000) throw new Error(vscode.l10n.t('The SARIF report exceeds the 20 MB import limit.'));
      await this.deps.session.exclusive(vscode.l10n.t('Import SARIF evidence'), async () => {
        if (this.currentReviewId() !== review.id) throw new Error(vscode.l10n.t('The active review changed. Run this action again.'));
        await this.ensureCurrentResult(review);
        const imported = importSarif(await readFile(uri.fsPath, 'utf8'), review);
        await this.ensureCurrentResult(review);
        this.deps.session.updateReview(imported);
      });
      this.deps.showSummary();
    });
  }

  // ---------------------------------------------------------------- results

  showResults(): void {
    this.deps.showSummary();
  }

  /** Markdown rendering of the review, ready to paste into a pull request description. */
  async openMarkdownReport(): Promise<void> {
    if (!this.deps.session.current) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No review yet. Run "Probato PR: Review Current Changes".'));
      return;
    }
    try { await this.ensureCurrentResult(this.deps.session.current); } catch (error) { await this.report(error); return; }
    await vscode.commands.executeCommand('markdown.showPreview', REPORT_URI);
  }

  exportReport(): Promise<void> {
    return this.guarded(async () => {
      const review = this.deps.session.current;
      if (!review) {
        return;
      }
      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', description: '.md', ext: 'md', render: renderMarkdown },
          { label: 'SARIF 2.1.0', description: vscode.l10n.t('.sarif — GitHub code scanning, SARIF viewers'), ext: 'sarif', render: renderSarif },
          { label: 'JSON', description: vscode.l10n.t('.json — full review with evidence'), ext: 'json', render: renderJson },
        ],
        { title: vscode.l10n.t('Export review report') },
      );
      if (!format) {
        return;
      }
      const folder = review.repository.root ? vscode.Uri.file(review.repository.root) : vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, `probato-review.${format.ext}`) } : {}),
        filters: { [format.label]: [format.ext] },
      });
      if (!target) {
        return;
      }
      await this.ensureCurrentResult(review);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(format.render(review)));
      this.deps.log.info(`Exported ${format.label} report to ${target.fsPath}`);
      const open = vscode.l10n.t('Open');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('Report saved: {0}', path.basename(target.fsPath)), open)) === open) {
        await vscode.window.showTextDocument(target);
      }
    });
  }

  async openFinding(id: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    const review = this.deps.session.current;
    const finding = review?.findings.find((f) => f.id === id);
    if (!review || !finding) {
      return;
    }
    if (!review.repository.root) {
      if (review.scope.pullRequest) {
        await vscode.env.openExternal(vscode.Uri.parse(`${review.scope.pullRequest.url}/files`));
      }
      return;
    }
    try {
      const file = await resolveInside(review.repository.root, finding.location.file);
      const line = Math.max(0, finding.location.startLine - 1);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(line, 0, line, 0), preview: true, ...(viewColumn ? { viewColumn } : {}) });
    } catch (error) {
      if (error instanceof PathOutsideWorkspaceError) {
        this.deps.log.warn(`Refused to open ${finding.location.file}: outside the repository.`);
        return;
      }
      void vscode.window.showWarningMessage(vscode.l10n.t('{0} cannot be opened (it may have been deleted by this change).', finding.location.file));
    }
  }

  async openEvidence(id: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(evidenceUri(id));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  // ---------------------------------------------------------------- plumbing

  private async withGitHubAuth<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === 'not-found' || error.kind === 'unauthorized' || error.kind === 'rate-limited')) {
        const signIn = vscode.l10n.t('Sign in to GitHub');
        const answer = await vscode.window.showWarningMessage(error.message, signIn);
        if (answer === signIn && (await this.deps.signInToGitHub())) {
          return call();
        }
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Resolves the repository to review. An explicit target must be inside an open workspace folder;
   * otherwise, with several repositories in the workspace, the user picks one.
   */
  private async pickRepository(target?: vscode.Uri): Promise<string | undefined> {
    if (target) {
      if (target.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(target)) {
        this.deps.log.warn(`Ignored review target outside the workspace: ${target.toString()}`);
        return undefined;
      }
      const top = await this.deps.git.topLevel(target.fsPath);
      if (!top) {
        void vscode.window.showWarningMessage(vscode.l10n.t('{0} is not inside a Git repository.', target.fsPath));
      }
      return top ? path.normalize(top) : undefined;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = new Set<string>();
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const top = await this.deps.git.topLevel(folder.uri.fsPath);
      if (top) {
        roots.add(path.normalize(top));
      }
    }
    const list = [...roots];
    if (list.length === 0) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No Git repository found in this workspace. Open a folder that is a Git repository (or run "git init") to review changes.'));
      return undefined;
    }
    if (list.length === 1) {
      return list[0];
    }
    const picked = await vscode.window.showQuickPick(
      list.map((root) => ({ label: path.basename(root), description: root, root, ...(root === this.lastRepo ? { picked: true } : {}) })),
      { title: vscode.l10n.t('Select the repository to review') },
    );
    this.lastRepo = picked?.root ?? this.lastRepo;
    return picked?.root;
  }

  private currentReviewId(): string | undefined { return this.deps.session.base?.id; }

  private async ensureCurrentResult(review: ReviewResult, signal?: AbortSignal): Promise<void> {
    if (this.currentReviewId() !== review.id) throw new Error(vscode.l10n.t('The active review changed. Run this action again.'));
    if (review.repository.root) {
      ensureSavedRepository(review.repository.root);
      await assertReviewCurrent(this.deps.git, review, signal, false);
    }
    if (this.currentReviewId() !== review.id) throw new Error(vscode.l10n.t('The active review changed. Run this action again.'));
  }

  private ensureTrusted(): boolean {
    if (vscode.workspace.isTrusted) {
      return true;
    }
    const manage = vscode.l10n.t('Manage Workspace Trust');
    void vscode.window
      .showWarningMessage(vscode.l10n.t('Probato PR runs Git and project tools, so it only works in trusted workspaces.'), manage)
      .then((answer) => (answer === manage ? vscode.commands.executeCommand('workbench.trust.manage') : undefined));
    return false;
  }

  /**
   * A repository whose root lies above every open folder (e.g. a home directory under Git) would review far
   * more than the user opened. Opening a monorepo subfolder is legitimate, so ask instead of refusing.
   */
  private async confirmOutsideRoot(root: string): Promise<boolean> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    if (folders.some((folder) => isWithin(folder, root))) {
      return true;
    }
    const review = vscode.l10n.t('Review {0}', path.basename(root) || root);
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('The open folder is inside the Git repository {0}. Review that whole repository?', root),
      { modal: true, detail: vscode.l10n.t('Changes anywhere in {0} are included, not only in the open folder.', root) },
      review,
    );
    return answer === review;
  }

  private run(label: string, operation: (signal: AbortSignal, root: string, report: ProgressReporter) => Promise<void>, target?: vscode.Uri): Promise<void> {
    return this.guarded(async () => {
      const root = await this.pickRepository(target);
      if (!root || !(await this.confirmOutsideRoot(root))) {
        return;
      }
      await this.exclusiveWithProgress(label, vscode.ProgressLocation.Window, `Probato PR: ${label}`, (signal, report) => operation(signal, root, report));
    });
  }

  /** One operation at a time, with cancellable progress UI; cancelling the progress aborts the operation. */
  private exclusiveWithProgress(
    label: string,
    location: vscode.ProgressLocation,
    title: string,
    operation: (signal: AbortSignal, report: (message: string) => void) => Promise<void>,
  ): Promise<void> {
    return this.deps.session.exclusive(label, (signal) =>
      vscode.window.withProgress({ location, title, cancellable: true }, async (progress, token) => {
        const subscription = token.onCancellationRequested(() => this.deps.session.cancel());
        try {
          await operation(signal, (message) => {
            progress.report({ message });
          });
        } finally {
          subscription.dispose();
        }
      }),
    );
  }

  /** Central error handling: every failure becomes an actionable message plus a full log entry. */
  private async guarded(operation: () => Promise<void>): Promise<void> {
    if (!this.ensureTrusted()) {
      return;
    }
    try {
      await operation();
    } catch (error) {
      await this.report(error);
    }
  }

  private async report(error: unknown): Promise<void> {
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
    this.deps.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    let message: string;
    const actions: string[] = [showLog];
    if (error instanceof GitNotFoundError) {
      message = vscode.l10n.t('Git was not found. Install Git (https://git-scm.com/downloads), make sure it is on PATH, and reload VS Code.');
    } else if (error instanceof OutputTooLargeError) {
      message = vscode.l10n.t('The diff is larger than probatoPR.review.maxDiffBytes. Review fewer changes or raise the limit.');
      actions.unshift(vscode.l10n.t('Open Settings'));
    } else if (error instanceof GitError) {
      message = vscode.l10n.t('Git error: {0}', error.message);
    } else if (error instanceof GitHubError || error instanceof AiProviderError || error instanceof InvalidBaseUrlError) {
      message = error.message;
    } else {
      message = vscode.l10n.t('Unexpected error: {0}', error instanceof Error ? error.message : String(error));
    }
    const answer = await vscode.window.showErrorMessage(message, ...actions);
    if (answer === showLog) {
      this.deps.log.show(true);
    } else if (answer === vscode.l10n.t('Open Settings')) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'probatoPR.review');
    }
  }
}
