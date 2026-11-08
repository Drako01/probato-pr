# Security Policy

## Threat model

Probato PR treats the following as **untrusted input**: repository files, Git configuration, package-manager scripts, pull request metadata and diffs, and every AI model response. The full model, with the test that proves each control and the residual risks, is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

| Risk | Mitigation |
| --- | --- |
| Command injection | Processes are spawned with argument arrays and `shell: false`. On Windows, `npm`/`pnpm`/`yarn` shims go through `cmd.exe` only after every argument matches a strict allowlist (`[\w:./=@+-]`). Git refs are validated before use. |
| Repository config executing code during Git reads | Every Git call sets `core.fsmonitor=false`, `diff.external=`, `--no-ext-diff`, `--no-textconv`, `core.pager=cat`; baseline worktrees disable hooks. A test verifies a malicious `core.fsmonitor` is not executed. |
| Running repository scripts | Never without approval. The check picker shows each check's label, kind, rationale and warnings (for example "Executes repository code"); the confirmation modal lists the exact executable and arguments of the selected checks. **Neither shows the full body of the scripts those commands call: review them in the repository before approving.** Verification requires selection plus modal confirmation, and states that commands run with normal user permissions. **There is no sandbox.** Checks that run repository code are never pre-selected. With *Run and remember*, the approval is stored in the extension's workspace storage (never in the repository) and bound to a SHA-256 of the command, its directory and the script body: any change, including one introduced by a branch you check out, voids it and asks again. *Forget Approved Checks* removes every remembered approval. |
| Path traversal / symlink escape | All repository-relative paths (from diffs, PR APIs, AI output) resolve through `resolveInside`, which rejects absolute paths, `..` traversal, NUL bytes and symlinks leaving the repository, including a symlinked parent of a path that does not exist yet. |
| Destroying user data | Reviews are read-only. Local Git actions (branch, stage, commit, push, sync, delete merged branch) run only from explicit commands, never during a review. Baseline worktrees live in the OS temp folder; the `node_modules` link is removed with `unlink` and verified before the worktree is deleted (covered by a test). |
| Secret leakage | One secret-pattern catalog redacts command output stored as evidence, report excerpts and AI context. Sensitive files (`.env`, keys, certificates, credentials) are never sent to AI providers. API keys use VS Code SecretStorage. |
| API key exfiltration through configuration | AI keys are stored per server origin, so a key entered for one server is never sent to another. The OpenAI-compatible base URL is an application-scoped setting (a repository's `.vscode/settings.json` cannot change it), must be HTTPS unless it points at loopback, and may not embed credentials. Redirects from the AI server are never followed, so repository data cannot be resent to another host. |
| Prompt injection | Repository content (diffs, file contents, file paths and known findings) is fenced as data, the fence and section tags cannot be closed or opened from inside, instructions say data is never instructions, AI output is parsed as JSON with a schema, findings outside the reviewed diff are rejected, and nothing in an AI response is ever executed. |
| Markdown/HTML injection | Report text from repositories is escaped; tree tooltips use untrusted `MarkdownString` with HTML and command links disabled. |
| Review Summary webview | Strict Content Security Policy (`default-src 'none'`, scripts only by per-load nonce, styles and scripts only from the extension's own `dist/webview` and `media` folders), command URIs disabled. Repository text is sent as data and rendered with `textContent`, never as HTML. Every message from the webview is validated against a schema and an allowlist of Probato PR commands; anything else is rejected and logged. |
| Orphaned processes | Cancellation and timeouts kill the whole process tree (`taskkill /T` on Windows, process groups elsewhere); covered by a test with a grandchild process. |
| Untrusted workspaces | Declared `untrustedWorkspaces: limited`; every command refuses to run Git or tools until the workspace is trusted. |

## Permissions

- **GitHub authentication:** VS Code's built-in GitHub authentication with the `repo` scope, requested only when a request needs it (public repositories can be reviewed unauthenticated). The `repo` scope allows writes; Probato PR uses them only through the delivery actions below.
- **GitHub reads:** *Review Pull Request* and the status/CI views only read (PR metadata, files, check runs, Actions logs, review threads).
- **GitHub writes (explicit user actions only, never during a review):**

  | Action | GitHub effect | Confirmation |
  | --- | --- | --- |
  | Create or Update Pull Request | Creates a pull request (you choose draft or ready) or updates its title/description; toggles draft state | Text preview plus modal confirmation; refused if the checkout changed meanwhile |
  | Publish Selected Findings | Creates or updates review comments for the findings you selected | Text preview of every comment plus modal confirmation |
  | Review decision | Submits a `COMMENT`, `APPROVE` or `REQUEST_CHANGES` review | Modal confirmation showing the body and decision |
  | Conversations | Replies to review comments; resolves or unresolves threads | Modal confirmation per action |
  | Merge Pull Request / merge queue | Merges the expected head commit or adds the PR to the merge queue | Modal confirmation showing head and base SHAs; the expected head and base are re-checked so a moved branch is refused |

  Every write is bound to the pull request head commit you reviewed.

  Probato PR never enables auto-merge, bypasses branch protection, creates releases or tags, or edits repository settings.
- **Local Git writes (explicit commands only):** create/switch branch, stage, commit, push with upstream, synchronize, delete a merged local branch. Commit hooks run with your permissions.
- **File system:** reads repository files; writes only to the extension's workspace storage (review history), temporary baseline worktrees, report files you explicitly save, and the working tree/index when you run a local Git action.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** (<https://github.com/Drako01/probato-pr/security/advisories/new>). If you cannot use GitHub, email **<addistefano76@gmail.com>** with the subject `Probato PR security`. Include the version, platform and reproduction steps. Do not open public issues for security problems. You will receive an acknowledgement within 5 business days.

## Supported versions

Only the latest released version receives security fixes during the 0.x series.
