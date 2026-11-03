import * as vscode from 'vscode';
import { repositorySnapshot } from '../git/repository-snapshot';
import type { GitClient } from '../git/git-client';
import { LocalDelivery } from '../git/local-delivery';
import { redactSecrets } from '../core/secrets';
import { ensureSavedRepository } from './review-state';
import type { ReviewSession } from './review-session';

export class LocalDeliveryController {
  private readonly local: LocalDelivery;
  constructor(private readonly session: ReviewSession, private readonly git: GitClient) { this.local = new LocalDelivery(git); }
  async open(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    const choices = [
      { label: vscode.l10n.t('Create branch'), id: 'branch' },
      { label: vscode.l10n.t('Switch branch'), id: 'switch' },
      { label: vscode.l10n.t('Stage selected files'), id: 'stage' },
      { label: vscode.l10n.t('Commit staged files'), id: 'commit' },
      { label: vscode.l10n.t('Push branch'), id: 'push' },
      { label: vscode.l10n.t('Synchronize branch (fast-forward only)'), id: 'sync' },
      { label: vscode.l10n.t('Delete a merged local branch'), id: 'delete' },
    ];
    try {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
      const roots = [...new Set((await Promise.all(folders.map((f) => this.git.topLevel(f.uri.fsPath)))).filter((r): r is string => Boolean(r)))];
      const root = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map((r) => ({ label: r, root: r })), { title: vscode.l10n.t('Select the repository to review') }))?.root;
      if (!root) return;
      ensureSavedRepository(root);
      const choice = await vscode.window.showQuickPick(choices, { title: vscode.l10n.t('Local Git actions') });
      if (!choice) return;
      await this.session.exclusive(choice.label, async (signal) => {
        const before = await repositorySnapshot(this.git, root, signal);
        let branch: string | undefined;
        let files: string[] = [];
        let message: string | undefined;
        let detail = root;
        if (choice.id === 'branch') {
          branch = await vscode.window.showInputBox({ title: choice.label, prompt: vscode.l10n.t('New branch name'), ignoreFocusOut: true });
          if (!branch) return;
          detail += `\n${branch}`;
        } else if (choice.id === 'switch' || choice.id === 'delete') {
          const branches = (await this.git.exec(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).trim().split('\n').filter(Boolean);
          branch = await vscode.window.showQuickPick(branches, { title: choice.label });
          if (!branch) return;
          detail += `\n${branch}`;
        } else if (choice.id === 'stage') {
          const changed = (await this.git.exec(root, ['diff', '--name-only', '-z'])).split('\0').filter(Boolean);
          const untracked = await this.git.untrackedFiles(root);
          const selected = await vscode.window.showQuickPick([...new Set([...changed, ...untracked])].map((file) => ({ label: file })), { title: choice.label, canPickMany: true });
          if (!selected?.length) return;
          files = selected.map((f) => f.label);
          detail += `\n${files.join('\n')}`;
        } else if (choice.id === 'commit') {
          detail += `\n${await this.git.diff(root, ['--cached', '--stat'])}`;
          message = await vscode.window.showInputBox({ title: choice.label, prompt: vscode.l10n.t('Commit message (repository hooks may run)'), ignoreFocusOut: true });
          if (!message) return;
          detail += `\n${message}`;
        } else {
          detail += `\n${await this.git.currentBranch(root) ?? 'HEAD'}\n${await this.git.remoteUrl(root) ?? ''}`;
        }
        const proceed = vscode.l10n.t('Continue');
        if (await vscode.window.showWarningMessage(choice.label, { modal: true, detail: redactSecrets(detail) }, proceed) !== proceed) return;
        ensureSavedRepository(root);
        if ((await repositorySnapshot(this.git, root, signal)).fingerprint !== before.fingerprint) throw new Error(vscode.l10n.t('Repository content changed while confirming the Git action. Try again.'));
        signal.throwIfAborted();
        try {
        switch (choice.id) {
          case 'branch': if (branch) await this.local.createBranch(root, branch, signal); break;
          case 'switch': if (branch) await this.local.switchBranch(root, branch, signal); break;
          case 'stage': await this.local.stage(root, files, signal); break;
          case 'commit': if (message) await this.local.commit(root, message, signal); break;
          case 'push': await this.local.push(root, signal); break;
          case 'sync': await this.local.synchronize(root, signal); break;
          case 'delete': if (branch) await this.local.deleteMergedBranch(root, branch, signal); break;
        }
        } finally { this.session.invalidate(); }
        void vscode.window.showInformationMessage(vscode.l10n.t('Git action completed. Review the current state again before sharing evidence.'));
      });
    } catch (error) {
      void vscode.window.showErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  }
}
