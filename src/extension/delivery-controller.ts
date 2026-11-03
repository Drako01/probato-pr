import * as vscode from 'vscode';
import { severityLabel, verificationLabel } from '../core/labels';
import type { ReviewResult } from '../core/model';
import { redactSecrets } from '../core/secrets';
import type { GitClient } from '../git/git-client';
import { GitHubClient, parseGitHubRemote, type GitHubRepoRef } from '../github/github-client';
import { buildReviewDraft, GitHubDelivery, type DeliveryPull } from '../github/delivery';
import { renderPullRequestDescription } from '../reports/markdown';
import type { ReviewSession } from './review-session';

export interface DeliveryControllerDeps {
  readonly session: ReviewSession;
  readonly git: GitClient;
  readonly github: GitHubClient;
  readonly state: vscode.Memento;
  readonly signInToGitHub: () => Promise<boolean>;
  readonly ensureReviewCurrent?: (review: ReviewResult) => Promise<void>;
  readonly log: vscode.LogOutputChannel;
}
interface Target { readonly root: string; readonly ref: GitHubRepoRef }
const STATE_PREFIX = 'probatoPR.delivery:';

/** Serializes actions, presents exact previews and binds every PR write to the selected head. */
export class DeliveryController {
  private readonly delivery: GitHubDelivery;
  constructor(private readonly deps: DeliveryControllerDeps) { this.delivery = new GitHubDelivery(deps.github); }

  async open(): Promise<void> {
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage(vscode.l10n.t('Trust the workspace before using GitHub delivery.')); return; }
    const picked = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Sign in to GitHub'), action: () => this.signIn() },
      { label: vscode.l10n.t('Create or update a pull request'), action: () => this.publishPullRequest() },
      { label: vscode.l10n.t('Select the active pull request'), action: () => this.selectPullRequest() },
      { label: vscode.l10n.t('Publish selected findings'), action: () => this.publishReview() },
      { label: vscode.l10n.t('Review conversations'), action: () => this.conversations() },
      { label: vscode.l10n.t('Submit a review'), action: () => this.submitReview() },
      { label: vscode.l10n.t('Change draft or ready state'), action: () => this.changeDraft() },
      { label: vscode.l10n.t('Pull request and CI status'), action: () => this.status() },
      { label: vscode.l10n.t('Watch CI until it completes'), action: () => this.watch() },
      { label: vscode.l10n.t('Merge pull request'), action: () => this.merge() },
      { label: vscode.l10n.t('Add to merge queue'), action: () => this.enqueue() },
    ], { title: vscode.l10n.t('Probato PR: GitHub delivery') });
    await picked?.action();
  }

  async signIn(): Promise<void> {
    await this.guarded(async () => { if (await this.deps.signInToGitHub()) void vscode.window.showInformationMessage(vscode.l10n.t('Connected to GitHub.')); });
  }

  async publishPullRequest(): Promise<void> {
    await this.operation(vscode.l10n.t('Publishing pull request'), async (target, signal) => {
      const branch = await this.deps.git.currentBranch(target.root);
      const head = await this.deps.git.resolveCommit(target.root, 'HEAD');
      if (!branch || !head) throw new Error(vscode.l10n.t('Check out a named branch with a commit first.'));
      if (await this.deps.git.isDirty(target.root)) throw new Error(vscode.l10n.t('Commit and push your changes before publishing a pull request.'));
      const repo = await this.delivery.repository(target.ref, signal);
      const matching = await this.delivery.branchPulls(target.ref, branch, signal);
      if (matching.length > 1) throw new Error(vscode.l10n.t('Several pull requests match this branch. Select the intended pull request explicitly.'));
      const current = matching[0] ? await this.delivery.pull(target.ref, matching[0].number, signal) : undefined;
      if (current && current.head.sha !== head) throw new Error(vscode.l10n.t('Push the current commit before updating the pull request.'));
      const base = current?.base.ref ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Target branch'), value: repo.default_branch, ignoreFocusOut: true });
      if (!base || base === branch) return;
      const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Pull request title'), value: current?.title ?? branch, ignoreFocusOut: true });
      if (!title?.trim()) return;
      const review = this.deps.session.current;
      if (review?.repository.root === target.root) await this.deps.ensureReviewCurrent?.(review);
      const initial = current?.body ?? (review?.repository.root === target.root ? renderPullRequestDescription(review) : '');
      const body = await this.editText(vscode.l10n.t('Edit the pull request description, then choose Continue.'), initial);
      if (body === undefined) return;
      const mode = current ? { draft: current.draft } : await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Create draft'), draft: true }, { label: vscode.l10n.t('Create ready for review'), draft: false },
      ], { title: vscode.l10n.t('Pull request state') });
      if (!mode) return;
      const publishedBody = `${body}\n\n<!-- probato-pr:reviewed-sha:${head} -->`;
      const detail = `${target.ref.owner}/${target.ref.repo}\n${branch} -> ${base}\n${head}\n\n${title}\n\n${publishedBody}`;
      await this.preview(detail);
      if (!await this.confirm(vscode.l10n.t('Publish this pull request?'), detail)) return;
      if (await this.deps.git.resolveCommit(target.root, 'HEAD') !== head || await this.deps.git.isDirty(target.root)) throw new Error(vscode.l10n.t('The checkout changed during confirmation. Review it again.'));
      if (review?.repository.root === target.root) await this.deps.ensureReviewCurrent?.(review);
      if (current) await this.delivery.assertHead(target.ref, current.number, head, signal);
      const pull = await this.delivery.createOrUpdate(target.ref, { title: redactSecrets(title), body: redactSecrets(publishedBody), head: branch, base, draft: mode.draft, expectedSha: head, ...(current ? { expectedNumber: current.number } : {}) }, signal);
      await this.remember(target, pull);
      void vscode.window.showInformationMessage(vscode.l10n.t('Pull request #{0} published.', pull.number));
    });
  }

  async selectPullRequest(): Promise<void> {
    await this.operation(vscode.l10n.t('Selecting pull request'), async (target, signal) => { await this.pickPull(target, signal, true); });
  }

  async publishReview(): Promise<void> {
    await this.operation(vscode.l10n.t('Publishing review findings'), async (target, signal) => {
      const review = this.deps.session.current;
      if (!review || review.repository.root !== target.root) throw new Error(vscode.l10n.t('Review this repository before publishing findings.'));
      await this.deps.ensureReviewCurrent?.(review);
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      if (review.scope.headIsWorkingTree || review.scope.kind === 'staged' || (review.scope.headSha ?? review.repository.headSha) !== pull.head.sha) throw new Error(vscode.l10n.t('Review the committed pull request head before publishing findings.'));
      const chosen = await vscode.window.showQuickPick(this.deps.session.visibleFindings().map((finding) => ({ label: `${severityLabel(finding.severity)}: ${finding.title}`, description: `${finding.location.file}:${finding.location.startLine} - ${verificationLabel(finding.verification)}`, finding })), { canPickMany: true, title: vscode.l10n.t('Choose findings to publish (maximum 20 comment locations)') });
      if (!chosen?.length) return;
      const draft = buildReviewDraft(chosen.map((c) => c.finding), await this.deps.github.listPullFiles(target.ref, pull.number, signal));
      const text = [`${target.ref.owner}/${target.ref.repo} #${pull.number}`, `Commit: ${pull.head.sha}`, ...draft.comments.map((c) => `${c.path}:${c.line} (${c.side})\n\n${c.body}`), ...(draft.skipped.length ? [vscode.l10n.t('Not published (outside the diff or over the limit): {0}', draft.skipped.join('\n'))] : [])].join('\n\n---\n\n');
      await this.preview(text);
      if (!draft.comments.length) { void vscode.window.showWarningMessage(vscode.l10n.t('None of the selected findings can be attached to this diff.')); return; }
      if (!await this.confirm(vscode.l10n.t('Publish these {0} observations?', draft.comments.length), text)) return;
      await this.deps.ensureReviewCurrent?.(review);
      const result = await this.delivery.publishReview(target.ref, pull.number, pull.head.sha, draft, signal);
      void vscode.window.showInformationMessage(vscode.l10n.t('Published {0} new observation(s), updated {1}. Existing conversations were preserved.', result.created, result.updated));
    });
  }

  async status(): Promise<void> {
    await this.operation(vscode.l10n.t('Refreshing pull request status'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      const status = await this.delivery.status(target.ref, pull.number, signal);
      await this.preview([`${target.ref.owner}/${target.ref.repo} #${pull.number}: ${pull.title}`, pull.html_url, vscode.l10n.t('Head commit: {0}', status.pull.head.sha), vscode.l10n.t('GitHub state: {0}', githubStateLabel(status.pull.mergeable_state)), ...status.checks.map((c) => `${githubStateLabel(c.state)}: ${c.name}${c.url ? `\n${c.url}` : ''}`), ...status.blockers].join('\n\n'));
      const selected = await vscode.window.showQuickPick(status.checks.filter((c) => c.url).map((c) => ({ label: c.name, description: githubStateLabel(c.state), url: c.url ?? '' })), { title: vscode.l10n.t('Choose a CI job to read its logs') });
      if (!selected) return;
      const url = new URL(selected.url);
      const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url.pathname)?.[1];
      if (url.hostname === 'github.com' && job) {
        const text = redactSecrets(await this.deps.github.jobLog(target.ref, Number(job), signal));
        await this.showText(text, 'plaintext');
      } else if (url.protocol === 'https:' && url.hostname === 'github.com') {
        await vscode.env.openExternal(vscode.Uri.parse(url.href));
      }
    });
  }

  async watch(): Promise<void> {
    await this.operation(vscode.l10n.t('Watching CI (cancel to stop)'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      this.deps.log.show(true);
      for (let attempt = 0; attempt < 120; attempt++) {
        signal.throwIfAborted();
        const status = await this.delivery.status(target.ref, pull.number, signal);
        this.deps.log.info(`PR #${pull.number} ${status.pull.head.sha}: ${status.checks.map((c) => `${c.name}=${c.state}`).join(', ')}. ${status.blockers.join(' ')}`);
        if (status.pull.head.sha !== pull.head.sha) throw new Error(vscode.l10n.t('The pull request head changed. Review the new commit before continuing.'));
        if (status.checks.length && status.checks.every((c) => !['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(c.state))) {
          void vscode.window.showInformationMessage(vscode.l10n.t('CI completed. Refresh pull request status to inspect results.')); return;
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => { clearTimeout(timer); reject(new Error(vscode.l10n.t('CI watch cancelled.'))); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 15_000);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
      void vscode.window.showInformationMessage(vscode.l10n.t('CI watch reached 30 minutes. Run it again to continue.'));
    });
  }

  async merge(): Promise<void> {
    await this.operation(vscode.l10n.t('Merging pull request'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      const status = await this.delivery.status(target.ref, pull.number, signal);
      if (status.blockers.length) throw new Error(status.blockers.join('\n'));
      const method = await vscode.window.showQuickPick(status.methods.map((value) => ({ label: mergeMethodLabel(value), value })), { title: vscode.l10n.t('Merge method') });
      if (!method || !await this.confirm(vscode.l10n.t('Merge pull request #{0}?', pull.number), `${target.ref.owner}/${target.ref.repo}\n${status.pull.head.ref} -> ${status.pull.base.ref}\n${status.pull.base.sha}\n${status.pull.head.sha}\n${method.label}`)) return;
      const sha = await this.delivery.merge(target.ref, pull.number, status.pull.head.sha, method.value, status.pull.base, signal);
      await this.deps.state.update(STATE_PREFIX + target.root, undefined);
      void vscode.window.showInformationMessage(vscode.l10n.t('Pull request merged at {0}. Use Sync after merge to update the local checkout.', sha.slice(0, 12)));
    });
  }

  private async enqueue(): Promise<void> {
    await this.operation(vscode.l10n.t('Adding pull request to merge queue'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull || !await this.confirm(vscode.l10n.t('Add pull request #{0} to the merge queue?', pull.number), `${pull.html_url}\n${pull.head.ref} -> ${pull.base.ref}\n${pull.head.sha}\n${pull.base.sha}`)) return;
      await this.delivery.enqueue(target.ref, pull.number, pull.head.sha, pull.base, signal);
      void vscode.window.showInformationMessage(vscode.l10n.t('Pull request added to the merge queue.'));
    });
  }

  private async changeDraft(): Promise<void> {
    await this.operation(vscode.l10n.t('Changing pull request state'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull || !await this.confirm(pull.draft ? vscode.l10n.t('Mark pull request ready for review?') : vscode.l10n.t('Convert pull request to draft?'), `${pull.html_url}\n${pull.head.sha}`)) return;
      await this.delivery.assertHead(target.ref, pull.number, pull.head.sha, signal);
      await this.delivery.setDraft(pull, !pull.draft, signal);
    });
  }

  private async submitReview(): Promise<void> {
    await this.operation(vscode.l10n.t('Submitting pull request review'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      const event = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Comment'), value: 'COMMENT' as const }, { label: vscode.l10n.t('Approve'), value: 'APPROVE' as const }, { label: vscode.l10n.t('Request changes'), value: 'REQUEST_CHANGES' as const },
      ], { title: vscode.l10n.t('Review decision') });
      if (!event) return;
      const body = await this.editText(vscode.l10n.t('Write the review message, then choose Continue.'), '');
      if (!body?.trim() || !await this.confirm(vscode.l10n.t('Submit this review?'), `${pull.html_url}\n${pull.head.sha}\n${event.label}\n\n${body}`)) return;
      await this.delivery.review(target.ref, pull.number, pull.head.sha, event.value, body, signal);
    });
  }

  private async conversations(): Promise<void> {
    await this.operation(vscode.l10n.t('Reviewing conversations'), async (target, signal) => {
      const pull = await this.pickPull(target, signal);
      if (!pull) return;
      const threads = await this.delivery.threads(target.ref, pull.number, signal);
      const thread = await vscode.window.showQuickPick(threads.map((value) => ({ label: `${value.isResolved ? vscode.l10n.t('[resolved]') : vscode.l10n.t('[open]')} ${value.comments[0]?.body.slice(0, 120) ?? value.id}`, description: value.comments[0]?.author?.login ?? '', value })), { title: vscode.l10n.t('Pull request conversations') });
      if (!thread) return;
      await this.showText(redactSecrets(thread.value.comments.map((c) => `${c.author?.login ?? ''}\n${c.body}\n${c.url}`).join('\n\n---\n\n')), 'plaintext');
      const action = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Reply'), value: 'reply' }, ...(thread.value.viewerCanResolve ? [{ label: thread.value.isResolved ? vscode.l10n.t('Reopen conversation') : vscode.l10n.t('Resolve conversation'), value: 'resolve' }] : []),
      ], { title: vscode.l10n.t('Conversation action') });
      if (action?.value === 'reply') {
        const body = await this.editText(vscode.l10n.t('Write a reply, then choose Continue.'), '');
        const commentId = thread.value.comments[0]?.databaseId;
        if (!body?.trim() || !commentId || !await this.confirm(vscode.l10n.t('Publish this reply?'), `${pull.html_url}\n\n${body}`)) return;
        await this.delivery.reply(target.ref, pull.number, commentId, body, signal);
      } else if (action?.value === 'resolve' && await this.confirm(action.label, `${pull.html_url}\n${thread.value.comments[0]?.body ?? ''}`)) {
        await this.delivery.resolve(thread.value.id, !thread.value.isResolved, signal);
      }
    });
  }

  private async target(): Promise<Target | undefined> {
    const local = this.deps.session.current?.repository.root;
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
    const selected = local ? undefined : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Select a Git repository') });
    const candidate = local || selected?.uri.fsPath;
    if (!candidate) return undefined;
    const root = await this.deps.git.topLevel(candidate);
    if (!root) throw new Error(vscode.l10n.t('No Git repository found.'));
    const remote = await this.deps.git.remoteUrl(root);
    const ref = remote ? parseGitHubRemote(remote) : undefined;
    if (!ref) throw new Error(vscode.l10n.t('The origin remote must be a GitHub repository.'));
    return { root, ref };
  }
  private async pickPull(target: Target, signal: AbortSignal, force = false): Promise<DeliveryPull | undefined> {
    const saved = this.deps.state.get<{ readonly owner: string; readonly repo: string; readonly number: number }>(STATE_PREFIX + target.root);
    const fromReview = this.deps.session.current?.scope.pullRequest;
    const number = saved?.owner === target.ref.owner && saved.repo === target.ref.repo ? saved.number : fromReview?.owner === target.ref.owner && fromReview.repo === target.ref.repo ? fromReview.number : undefined;
    if (!force && number) return this.delivery.pull(target.ref, number, signal);
    const pulls = await this.deps.github.listOpenPulls(target.ref, signal);
    const chosen = await vscode.window.showQuickPick(pulls.map((p) => ({ label: `#${p.number} ${p.title}`, description: `${p.head.ref} -> ${p.base.ref}`, number: p.number })), { title: vscode.l10n.t('Select a pull request') });
    if (!chosen) return undefined;
    const pull = await this.delivery.pull(target.ref, chosen.number, signal);
    await this.remember(target, pull);
    return pull;
  }
  private remember(target: Target, pull: DeliveryPull): Thenable<void> {
    return this.deps.state.update(STATE_PREFIX + target.root, { owner: target.ref.owner, repo: target.ref.repo, number: pull.number, headSha: pull.head.sha, url: pull.html_url });
  }
  private async showText(content: string, language: string): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument({ content: redactSecrets(content), language });
    await vscode.window.showTextDocument(doc, { preview: true });
    return doc;
  }
  private async editText(message: string, initial: string): Promise<string | undefined> {
    const doc = await this.showText(initial, 'markdown');
    const proceed = vscode.l10n.t('Continue');
    return await vscode.window.showInformationMessage(message, proceed) === proceed ? doc.getText() : undefined;
  }
  private async preview(content: string): Promise<void> { await this.showText(content, 'plaintext'); }
  private async confirm(message: string, detail: string): Promise<boolean> {
    const yes = vscode.l10n.t('Confirm');
    return await vscode.window.showWarningMessage(message, { modal: true, detail: redactSecrets(detail) }, yes) === yes;
  }
  private async operation(label: string, operation: (target: Target, signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.guarded(async () => {
      const target = await this.target();
      if (!target) return;
      await this.deps.session.exclusive(label, (signal) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Probato PR: ${label}`, cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => this.deps.session.cancel());
        try { await operation(target, signal); } finally { subscription.dispose(); }
      }));
    });
  }
  private async guarded(operation: () => Promise<void>): Promise<void> {
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage(vscode.l10n.t('Trust the workspace before using GitHub delivery.')); return; }
    try { await operation(); } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      this.deps.log.warn(message); void vscode.window.showErrorMessage(message);
    }
  }
}

function mergeMethodLabel(method: 'merge' | 'squash' | 'rebase'): string {
  switch (method) {
    case 'merge': return vscode.l10n.t('Merge commit');
    case 'squash': return vscode.l10n.t('Squash and merge');
    case 'rebase': return vscode.l10n.t('Rebase and merge');
  }
}

/** Unknown API states remain intact so new provider values are never misrepresented. */
function githubStateLabel(state: string): string {
  switch (state) {
    case 'success': return vscode.l10n.t('Passed');
    case 'failure': return vscode.l10n.t('Failed');
    case 'error': return vscode.l10n.t('Error');
    case 'pending': return vscode.l10n.t('Pending');
    case 'queued': return vscode.l10n.t('Queued');
    case 'in_progress': return vscode.l10n.t('In progress');
    case 'waiting': return vscode.l10n.t('Waiting');
    case 'requested': return vscode.l10n.t('Requested');
    case 'completed': return vscode.l10n.t('Completed');
    case 'neutral': return vscode.l10n.t('Neutral');
    case 'cancelled': return vscode.l10n.t('Cancelled');
    case 'skipped': return vscode.l10n.t('Skipped');
    case 'timed_out': return vscode.l10n.t('Timed out');
    case 'action_required': return vscode.l10n.t('Action required');
    case 'stale': return vscode.l10n.t('Outdated');
    case 'startup_failure': return vscode.l10n.t('Could not start');
    case 'clean': return vscode.l10n.t('Ready to merge');
    case 'dirty': return vscode.l10n.t('Merge conflicts');
    case 'unknown': return vscode.l10n.t('Unknown');
    case 'unstable': return vscode.l10n.t('Checks have not passed');
    case 'blocked': return vscode.l10n.t('Blocked by branch requirements');
    case 'behind': return vscode.l10n.t('Behind the base branch');
    case 'has_hooks': return vscode.l10n.t('Ready to merge with hooks');
    case 'draft': return vscode.l10n.t('Draft');
    default: return state;
  }
}
