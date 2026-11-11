# Delivery from the editor

Probato PR supports a complete GitHub pull request workflow from the editor. Open **Probato PR: GitHub Delivery**
or use the delivery controls in the Review Summary. **Local Git Actions** manages the local checkout.

## Prepare and review

1. Save the files you want to review.
2. Use Local Git Actions to create or select a branch when needed.
3. Review current changes, staged changes, a branch, a commit or a GitHub pull request.
4. Run Verify and explicitly select the project checks. Monorepos list checks with their project directory.
5. Inspect findings, executed diagnostics and any limitations. An AI hypothesis is never confirmed merely because
   a compiler reports a different error at the same line.

A review identifies the repository content it inspected. Changes to HEAD, the branch, the index, tracked files
or nonignored untracked files invalidate that identity. Review again before using old evidence. Unsaved editor
changes must be saved first. Staged and historical checks run in an isolated worktree without replacing the
user's index or checkout. Baselines with incompatible dependencies or check definitions remain inconclusive.

Remembered command approvals apply to the same repository content and execution definitions. Editing a command,
hook, script, configuration or repository file requires approval again. Commands run with your user permissions.

## Publish a pull request

1. Stage the selected files and inspect the commit preview in Local Git Actions.
2. Commit and push the branch. Commit hooks may execute; pushes may trigger the repository's CI workflows.
3. Review Branch after committing so the evidence describes the committed pull request head.
4. Choose Create or Update Pull Request, enter the target branch and title, then edit the description.
5. Inspect the exact repository, branch, commit and content before confirming publication.

Sign in to GitHub when the requested operation needs authentication. Repository permissions and branch rules
remain authoritative. Selecting an active pull request is persisted per repository. Changing the origin remote
requires selecting a matching pull request again.

## Collaborate and follow CI

**Publish Full Analysis to GitHub** posts the complete report (findings, severities, evidence, checks, comparison
and conclusions) as one PR conversation comment. The pull request is detected from the saved selection, the review
scope or the single open PR of the checked-out branch. You edit the Markdown in an editor before confirming; secrets
are redacted and the comment is truncated below GitHub's limit with a notice. Re-publishing updates your previous
Probato comment (never another user's or app's) instead of duplicating it, and nothing is written when the PR head
differs from the reviewed commit.

Publish Selected Findings lets you choose observations before showing a complete publication preview. Only
locations present in the selected pull request diff can become inline comments. Removed files use the left side.
Comments include evidence status, and existing conversations are preserved. A marker alone never grants
permission to modify another user's or application's comment.

GitHub Delivery also supports comments, approvals, requests for changes, replies, resolving and reopening
conversations, and changing a pull request between draft and ready. GitHub disallows approving your own PR.

Pull Request and CI Status shows checks and blockers. Select a GitHub Actions job to read a bounded, redacted log
inside the editor. Watch CI polls at 15-second intervals for up to 30 minutes and can be cancelled. A new PR head
ends that watch so results cannot silently describe a different commit.

## Integrate and close

Choose Merge Pull Request, inspect the destination and commit, and select an enabled merge method. Probato
refreshes readiness, review requirements and the expected head/destination before submitting the merge. It does
not request an administrator bypass. GitHub performs the final authorization and protection checks.

Repositories using a merge queue can use Add to Merge Queue. GitHub decides whether the repository and pull
request are eligible. After merging, switch to the destination branch and synchronize with fast-forward only.
Local Git Actions can delete a merged local branch; it never force-deletes or force-pushes.

## Command line and CI

Build with `pnpm run build:prod`, then run:

```bash
node dist/cli.cjs --scope branch --base origin/main --format sarif --output /tmp/probato.sarif
node dist/cli.cjs --list-checks
node dist/cli.cjs --scope working --verify script:typecheck --baseline --format json
node dist/cli.cjs --import-sarif /tmp/tool.sarif --fail-on high
```

On Windows, select a suitable temporary output path. Keep generated reports outside the analyzed repository or
ignore them in Git so they do not become input to the next review.

The CLI never executes project checks unless `--verify` names them or selects `all`. `--baseline` additionally
authorizes repeating failures on the base revision. Exit codes are 0 when the finding threshold is not reached,
1 when it is reached, and 2 for execution or configuration errors. Passing thresholds do not prove correctness.
Imported SARIF is external evidence; it cannot claim a verified execution or causal confirmation by Probato.

## Incremental review

Enable `probatoPR.review.onSave` to review current changes after saving a file. This never runs verification
commands or sends data to an AI automatically. Cached analyzer results are held only in memory and reused only
when the changed content and consumer/configuration workspace match. Cache limits fall back to fresh analysis.

## Scope of the new cross-stack checks

OpenAPI JSON/YAML and TypeScript DTO property removals, SQL column removals/renames and tenant-filter removals
produce conservative suspicions with concrete locations. Name matches do not prove a consumer type relationship,
SQL execution or authorization semantics. Use project type-checks, contract tests, migrations and isolation tests
to investigate them. These checks do not replace the project's security or database validation.
