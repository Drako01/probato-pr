# Changelog

All notable changes to Probato PR are documented here. The project follows [Semantic Versioning](https://semver.org/).

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
