import * as vscode from 'vscode';
import { checkKindLabel } from '../core/labels';
import type { PlannedCheck, ReviewResult } from '../core/model';
import type { RepositoryPolicy } from '../core/repository-policy';
import type { ApprovedChecks } from '../verification/approved-checks';
import { rankChecks } from '../verification/check-impact';
import type { Settings } from './settings';

/** Consent dialogs of local verification: which checks run, and whether failures are compared with the base. */
export class VerificationPrompts {
  constructor(
    private readonly approvals: ApprovedChecks,
    private readonly baselineMode: () => Settings['verification']['baseline'],
  ) {}

  /**
   * Checks remembered for this repository run without asking while their command and script are unchanged.
   * Otherwise the user picks and confirms, and may choose to be remembered.
   */
  async approveChecks(root: string, plan: readonly PlannedCheck[], changedFiles: readonly string[] = [], policy?: RepositoryPolicy): Promise<readonly PlannedCheck[] | undefined> {
    const { approved, changed } = this.approvals.match(root, plan);
    if (changed.length > 0) {
      await this.approvals.forget(root);
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} changed since you approved it, so Probato PR asks again before running anything.', changed.map((c) => c.label).join(', ')),
      );
    } else if (approved.length > 0) {
      const forget = vscode.l10n.t('Forget');
      void vscode.window
        .showInformationMessage(vscode.l10n.t('Running the checks you approved for this exact repository state: {0}.', approved.map((c) => c.label).join(', ')), forget)
        .then(async (answer) => {
          if (answer === forget) {
            await this.approvals.forget(root);
          }
        });
      return approved;
    }
    const items = rankChecks(plan, changedFiles, policy).map(({ check, recommendation }) => ({
      label: check.label,
      description: checkKindLabel(check.kind),
      detail: [recommendation?.reason ?? check.rationale, ...check.warnings, ...check.requires.map((r) => vscode.l10n.t('May require: {0}', r))].join(' · '),
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
      await this.approvals.remember(root, checks);
    }
    return answer === confirm || answer === remember ? checks : undefined;
  }

  async forgetAll(): Promise<void> {
    const count = await this.approvals.forgetAll();
    void vscode.window.showInformationMessage(
      count > 0 ? vscode.l10n.t('Probato PR will ask again before running checks in {0} repository(ies).', count) : vscode.l10n.t('There are no remembered checks.'),
    );
  }

  /** Base revision to re-run failing checks on, or undefined for a head-only run. */
  async chooseBaseline(review: ReviewResult): Promise<string | undefined> {
    const base = review.scope.baseSha;
    const mode = this.baselineMode();
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
}
