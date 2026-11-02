<p align="center">
  <img src="media/readme-logo.png" width="112" alt="Probato PR logo: the letter P drawn as a merge graph">
</p>

<h1 align="center">Probato PR</h1>

<p align="center"><strong>Code review with proof.</strong><br>Your AI reviews the code. We verify what could break.</p>

Probato PR reviews your Git changes and pull requests inside VS Code and tells you **what is proven, what is only suspected, and why**. It runs deterministic analyzers locally, can execute your project's own checks with your approval, and compares results against the base revision to tell a regression *introduced by your change* from a failure that was already there.

No account, no AI key, no server, no subscription is needed for the core review. When you want more, **bring your own AI**: GitHub Copilot, Claude, OpenAI or a local model.

## Why Probato PR

Most AI review tools return a list of opinions. Probato PR classifies every finding by the strength of its evidence:

| Status | Meaning |
|---|---|
| **Confirmed** | An executed check proves the defect, and a base-vs-head comparison attributes it to this change. |
| **Evidenced** | Objective technical evidence exists (an AST fact, a failing check), but causality is not fully proven. |
| **Suspected** | Probable issue from heuristics or AI. Not backed by an executed check. |
| **Not verified** | The verification this finding needs could not be performed — and the report says why. |

An AI claim on its own is never "confirmed": it becomes confirmed only when one of your executed checks fails at that exact line with this change and not on the base revision. A failing test is never blamed on your change without a passing baseline.

## Quick start

1. Install **Probato PR** from the Extensions view.
2. Open a folder that is a Git repository and **trust** the workspace.
3. Open the **Probato PR** view in the Activity Bar and click **Review Current Changes** (or use the compare button in the **Source Control** view, or run `Probato PR: Review Current Changes` from the Command Palette). In multi-root workspaces you pick the repository.
4. The **Review Summary** opens with the review risk, the findings and the next step highlighted. Click a finding to open the code beside it. Findings also appear in the **Problems** panel.
5. **Verify:** run your project's type-check, lint, tests or build. You choose exactly which commands run.
6. **Share:** click **Copy PR Description** and paste it into your pull request, or export a **Markdown**, **SARIF** or **JSON** report.
7. Optional: **Connect Your AI** to add a second opinion and a written walkthrough of the change (see below).

New to Probato PR? Run `Welcome: Open Walkthrough` and pick **Get started with Probato PR**.

## Features

- **Review scopes:** current changes (staged + unstaged + untracked), staged changes, a branch against its merge base, a single commit, or a GitHub pull request.
- **Deterministic analyzers (no AI):**
  - *Contracts* (TypeScript/JavaScript AST): removed or renamed exports still imported elsewhere, new required parameters with stale call sites, removed enum members and interface properties still in use, deleted or moved modules still imported.
  - *Test integrity:* deleted test files, removed cases, `.only` / `.skip` / `xit`, tests whose assertions were removed (AST), Go `t.Skip` and removed `TestXxx` functions.
  - *Secrets:* known credential formats on added lines, sensitive files (`.env`, keys, certificates) added to Git. Excerpts are always redacted.
  - *Error handling:* new empty `catch` blocks, swallowed promise rejections, new `@ts-ignore` / `@ts-nocheck` / `eslint-disable`.
  - *Dependencies:* new or changed install scripts (`postinstall`…), major upgrades, packages removed but still imported, local `replace` directives in `go.mod`.
  - *Configuration:* TypeScript strictness disabled, risky GitHub Actions triggers (`pull_request_target` + PR head checkout, `write-all`).
- **Verification engine:** detects checks already present in your project (package scripts, local TypeScript compiler, `go build/vet/test`), shows the exact commands, runs only what you approve, captures evidence (command, revision, exit code, duration, output hash, redacted output), and re-runs failing checks on the base revision in a temporary Git worktree to attribute failures.
- **Guided Review → Verify → Share flow:** the Review Summary panel, the Overview view and the status bar always show the same step states and the next action. Findings can be filtered by severity and grouped by severity or by file; the Activity Bar badge shows how many are open.
- **Explainable review risk:** a label (`LOW` … `CRITICAL`) with the reasons and the limitations behind it. Passing checks never mean "safe".
- **Reports:** Markdown, SARIF 2.1.0 (GitHub code scanning compatible) and full JSON with evidence.
- **Pull request description:** one click copies a Markdown description with the review risk, the executed checks and the top findings, plus the AI walkthrough when you ran one.
- **Bring your own AI (optional):** see the next section.

## Bring your own AI

Probato PR works without AI. Connecting one adds a second opinion on the change and a written walkthrough for the pull request description. Run **Probato PR: Connect Your AI** (or click *Connect Your AI* in the Review Summary): pick a provider, enter your key, and choose a model from the provider's own list. Listing the models also checks the connection, without spending tokens.

| Provider | What you need |
|---|---|
| Chat models already in VS Code | GitHub Copilot or another installed chat model provider. No API key. |
| Anthropic Claude | Your Anthropic API key. |
| OpenAI | Your OpenAI API key. |
| Any OpenAI-compatible API | A base URL and, if the server needs one, a key: OpenRouter, Azure OpenAI, Ollama, LM Studio… |

What the AI receives, and the guarantees around it:

- **You confirm every time.** Before each AI review, a dialog lists the files whose diff is sent, the files whose full content is added for context, and the files left out with the reason.
- **Context:** the diffs first, then the full current content of changed files while `probatoPR.ai.maxContextChars` allows (turn it off with `probatoPR.ai.includeFileContent`), plus what Probato PR already found so the model does not repeat it.
- **Never sent:** sensitive files (`.env*`, keys, certificates, credentials) and your `probatoPR.ai.exclude` globs. Detected secrets are redacted.
- **Keys** live in your OS keychain (VS Code SecretStorage), each one bound to the server it was entered for. The base URL is a user-level setting, so a repository's workspace settings cannot redirect your key. HTTPS is required except for servers on your own machine.
- **AI output is untrusted.** It is parsed against a schema; findings and walkthrough entries pointing at files or lines outside the shared diff are rejected; nothing in a response is ever executed. AI findings stay *suspected*, and become *confirmed* only when your own checks prove them.

## Requirements

- VS Code 1.99 or newer, desktop (local, WSL or remote hosts with a local file system).
- Git on `PATH`.
- For verification: your project's own tools already installed (e.g. `node_modules`, Go toolchain). Probato PR **never installs** anything.

## Supported languages

| Level | Languages |
|---|---|
| Diff review, secrets, configuration | Any text file |
| AST analysis (contracts, tests, error handling) | TypeScript, JavaScript (incl. TSX/JSX, ESM/CJS) |
| Line-level test checks, `go.mod` checks | Go |
| Verification (executes your tools) | Node.js projects (npm, pnpm, yarn scripts; local `tsc`), Go modules |

Python, PHP, Java, SQL migrations, OpenAPI, Docker and Terraform are on the roadmap (`ROADMAP.md`). Probato PR does not claim support for a language it only reads as text.

## Commands

| Command | Description |
|---|---|
| `Probato PR: Review Current Changes` | Staged, unstaged and untracked changes vs `HEAD`. |
| `Probato PR: Review Staged Changes` | Index vs `HEAD`. |
| `Probato PR: Review Branch` | `HEAD` vs merge base with the base branch. |
| `Probato PR: Review Commit` | One commit vs its parent. |
| `Probato PR: Review Pull Request (GitHub)` | Read-only, from the GitHub API. |
| `Probato PR: Verify Findings (Run Checks)` | Plan, approve and run project checks with baseline attribution. |
| `Probato PR: AI Review (Optional)` | Send the reviewed change to your AI after confirmation: second-opinion findings and a pull request walkthrough. |
| `Probato PR: Connect Your AI` | Choose an AI provider, store its key and pick the model. |
| `Probato PR: Delete Stored AI API Keys` | Removes every AI key Probato PR stored. |
| `Probato PR: Show Review Summary` | Opens the Review Summary panel: risk, next step, findings and checks. |
| `Probato PR: Copy PR Description` | Copies a pull request description: AI walkthrough (if any), risk, checks and top findings. |
| `Probato PR: Export Review Report` | Markdown, SARIF or JSON. |
| `Probato PR: Open Markdown Report (for the PR Description)` | Markdown preview of the review, ready to paste into a pull request. |
| `Probato PR: Cancel` | Stops the running operation and its child processes. |
| `Probato PR: Delete Local Review History` | Removes stored reviews for this workspace. |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `probatoPR.review.baseBranch` | `""` | Base for branch reviews; empty = `origin/HEAD`, then `main`/`master`. |
| `probatoPR.review.maxFiles` | `300` | Files analyzed per review; extra files are listed as skipped. |
| `probatoPR.review.maxDiffBytes` | `4000000` | Maximum diff size read from Git. |
| `probatoPR.review.exclude` | lockfiles, `dist`, `node_modules`… | Globs not analyzed. |
| `probatoPR.verification.timeoutSeconds` | `600` | Per-command timeout. |
| `probatoPR.verification.maxOutputBytes` | `1000000` | Output kept per command (tail). |
| `probatoPR.verification.baseline` | `ask` | Re-run failing checks on the base revision: `ask`, `always`, `never`. |
| `probatoPR.ai.provider` | `none` | `none`, `vscode-lm`, `anthropic`, `openai-compatible`. Set it with **Connect Your AI**. |
| `probatoPR.ai.anthropicModel` | `claude-opus-5-5` | Model for the Anthropic provider. |
| `probatoPR.ai.vscodeLmModel` | `""` | VS Code chat model (`vendor/id`); empty = first available. |
| `probatoPR.ai.openaiCompatible.baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible API URL. User-level only. |
| `probatoPR.ai.openaiCompatible.model` | `""` | Model ID for the OpenAI-compatible API. |
| `probatoPR.ai.includeFileContent` | `true` | Also send the full content of changed files for context. |
| `probatoPR.ai.maxContextChars` | `120000` | Characters of repository data (diffs + file content) sent per AI review. |
| `probatoPR.ai.exclude` | `[]` | Extra globs never sent to AI (sensitive files are always excluded). |

## Offline mode

Everything except pull request review and AI review works fully offline. If GitHub or the AI provider is unreachable, local review is unaffected.

## Security and privacy

- Works only in **trusted workspaces**; Restricted Mode disables it, as VS Code requires for tools that run processes.
- Read-only by default: reviews never modify your files. Verification commands run **only after explicit approval** and run with your normal user permissions — **they are not sandboxed**.
- Git is invoked with repository-config execution paths disabled (fsmonitor, external diff, textconv, hooks for the baseline worktree).
- Secrets are redacted from stored evidence, reports and AI context. API keys live in VS Code SecretStorage, bound to the server they were entered for.
- No telemetry. Nothing leaves your machine unless you use PR review (GitHub API) or AI review (after a confirmation that lists the files).

Details: `SECURITY.md` · `PRIVACY.md`.

## Known limitations

- Cross-file contract analysis resolves relative imports and the root `tsconfig.json` `baseUrl`/`paths` aliases; `extends` chains and package-name self-imports are not followed yet (a passing type-check automatically downgrades such findings to *suspected*).
- Baseline runs link `node_modules` from your checkout; monorepos with per-package `node_modules` may produce inconclusive baselines.
- Pull requests are reviewed from the GitHub API; verification and cross-file analysis require the PR head to be checked out locally.
- Verified on Windows 11 with VS Code 1.144. Linux, macOS, WSL, Dev Containers and Remote SSH have not been verified yet — see `PRODUCT_RELEASE_READINESS.md`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Git was not found" | Install Git and make sure `git --version` works in a terminal, then reload VS Code. |
| "Nothing to review" | No changes in the selected scope. Try **Review Branch** or **Review Commit**. |
| A check reports `error` | The tool is not installed or not on `PATH`; the evidence log shows the exact message. |
| Baseline is "inconclusive" | The base revision could not run the check (e.g. different dependencies). The failure is not attributed. |
| Commands are disabled | Trust the workspace (`Manage Workspace Trust`). |

Logs: **Output → Probato PR**.

## Development

```bash
pnpm install
pnpm run verify          # typecheck + lint + unit tests
pnpm run test:integration  # real VS Code Extension Development Host
pnpm run perf            # performance budgets on generated repositories
pnpm run package         # verify + production build + VSIX
```

Press `F5` in VS Code to launch an Extension Development Host. See `CONTRIBUTING.md` and `ARCHITECTURE.md`.

## Support

Bug reports and feature requests: see `SUPPORT.md`.

## License

[MIT](LICENSE) © 2026 Alejandro Daniel Di Stefano. Bundled third-party components keep their own licenses (`THIRD_PARTY_NOTICES.md`).

---

Probato PR is developed by **Alejandro Daniel Di Stefano** — [ArmoTuSitio](https://armotusitio.com.ar). The product name is provisional pending trademark verification.
