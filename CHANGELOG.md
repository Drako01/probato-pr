# Changelog

All notable changes to Probato PR are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-11-02

### Added

- **Verification for PHP, Python, Rust and Java/Kotlin**, besides JavaScript/TypeScript and Go:
  - PHP: Composer scripts, or PHPStan, PHP_CodeSniffer, PHPUnit and Pest from `vendor/bin`.
  - Python: mypy, ruff and pytest when the project configures them, run with its virtual environment (`.venv`, `venv`, `env`) and only if installed there; otherwise with the interpreter on `PATH`, and the plan says so.
  - Rust: `cargo check`, `cargo clippy`, `cargo test`.
  - Java/Kotlin: Maven `compile`/`test` and Gradle `assemble`/`test`, through the committed `mvnw`/`gradlew` wrapper when there is one. The wrapper's content is part of the approval fingerprint.
- Compiler and linter errors from these tools are linked to findings at the same line (new `gnu` and `maven` output formats), so they can confirm a finding like `tsc` and `go` already did. Absolute paths inside the checked directory are understood.

### Changed

- Check detection is organized per ecosystem (`src/verification/ecosystems/`).

### Notes

- PHP and Python baselines do not reuse `vendor/` or the virtual environment on purpose: an autoloader or an editable install would load the changed code and produce a false attribution, so such failures are reported as inconclusive.

## [0.1.3] — 2026-11-02

### Added

- **Run and remember:** approved checks can run without asking again in the same repository. The approval is stored outside the repository and bound to a hash of the command, its directory and the script body, so any change asks again. New command *Forget Approved Checks*.
- **Always compare** in the base-revision question saves the choice in your user settings.
- Light-bulb actions on Probato PR diagnostics: dismiss the finding, show its evidence, open the Review Summary.

### Changed

- Markdown reports and the pull request description follow the VS Code display language, with readable check results and attributions ("Failed (Introduced by this change)" instead of "FAIL (introduced)").
- Evidence entries in the Verification view show the command first, where it ran ("with this change", "on the base revision") and a tooltip with commit, exit code and duration.

### Fixed

- With a non-English display language, checks that run repository scripts were pre-selected in the approval list. Pre-selection now relies on whether the check runs repository code, not on the warning text.

## [0.1.2] — 2026-11-02

### Fixed

- The review scope label (current changes, staged changes, branch changes since a branch, commit, pull request) follows the VS Code display language.
- Spanish finding titles for added items no longer disagree in gender ("Se agregó en archivo: elemento" instead of "elemento agregado").

### Added

- Screenshots in the README (Review Summary, findings with evidence status, check approval).

## [0.1.1] — 2026-11-02

### Fixed

- Finding titles and descriptions, verification notes, risk reasons, limitations, check details and progress messages now follow the VS Code display language (Spanish included). Previously they were always shown in English inside a Spanish UI. Finding ids do not depend on the language, so dismissed findings stay dismissed after switching it.

## [0.1.0] — 2026-11-02

First public release (Preview) on the Visual Studio Marketplace.

### Added

- Local review of current, staged, branch and commit changes; read-only GitHub pull request review.
- Deterministic analyzers: contracts (TS/JS AST), test integrity (TS/JS AST, Go line-level), secrets, error handling, dependencies, configuration.
- Evidence model with Confirmed / Evidenced / Suspected / Not verified classification.
- Verification engine: check detection, explicit approval, safe process execution (timeouts, cancellation, process-tree cleanup, output limits), command evidence, base-revision re-runs in temporary worktrees, regression attribution (introduced / pre-existing / fixed / inconclusive), linking of tool diagnostics to findings.
- Explainable review risk with reasons and limitations.
- Activity Bar views (Overview, Findings, Verification), editor diagnostics, finding dismissal, virtual report and evidence documents.
- Markdown, SARIF 2.1.0 and JSON reports.
- Optional AI review via the VS Code Language Model API or Anthropic Claude, with consent dialog, redaction, prompt-injection fencing and hallucination rejection.
- English and Spanish localization (manifest and runtime messages).
- Contract analysis resolves `tsconfig.json` `baseUrl` / `paths` aliases.
- Review commands accept a target repository: Source Control view button and multi-root support.
- Confirmation before reviewing a repository whose root is above the opened folder (e.g. a home directory under Git).
- Guided Review → Verify → Share flow shared by every surface: Review Summary panel (risk, next step, filterable findings, checks with evidence), step-based Overview view, persistent status bar entry and Activity Bar badge.
- Findings view grouping by severity or by file, and empty states with next actions in every view.
- Get Started walkthrough and the *Open Markdown Report (for the PR Description)* command.
- Localized check statuses and attributions (previously shown as raw identifiers).
- Brand mark: the letter P drawn as a merge graph.
- MIT License.
- Bring your own AI: *Connect Your AI* setup (VS Code chat models, Anthropic, OpenAI and any OpenAI-compatible API such as OpenRouter, Azure OpenAI, Ollama or LM Studio), models listed from the provider, keys bound to their server origin.
- Richer AI context: full content of changed files (optional) and already-known findings; the confirmation dialog lists every file and how it is shared.
- AI walkthrough of the change (overview, per-file summary, where to look first) shown in the Review Summary, the Markdown report and the new *Copy PR Description* command, which also works without AI.
- AI findings are upgraded to *confirmed* when an executed check fails at the same line only after the change ("AI suspicion confirmed").
- Marked as Preview in the Marketplace manifest.

### Changed

- *Set Anthropic API Key* replaced by *Connect Your AI* and *Delete Stored AI API Keys*.
