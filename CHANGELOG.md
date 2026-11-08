# Changelog

All notable changes to Probato PR are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- CLI `--gate absolute|regression-only|hybrid` and `--on-inconclusive fail|warn`. The default (`absolute`) keeps the
  0.6.0 exit codes; differential modes block only demonstrated regressions and print their decision to stderr.

### Fixed

- SARIF: `security-severity` is emitted only for security rules; other rules use `problem.severity`, so quality
  issues are no longer presented as vulnerabilities in GitHub code scanning. Rule severity is the most severe finding.
- `SECURITY.md`, `PRIVACY.md` and the manual test plan now describe the GitHub and local Git writes Probato performs and
  what the check approval UI actually shows.

## [0.6.0] — 2026-11-07

### Added

- Code of Conduct (Contributor Covenant 2.1), linked from the contributing guide and README.

### Changed

- Removed the Preview badge from the Marketplace manifest.
- Updated `@anthropic-ai/sdk` to 1.6.0 and `vitest` to 5.1.0.
- Test repositories no longer inherit the global `core.autocrlf` setting, which removes line-ending warnings on Windows.

## [0.5.0] — 2026-11-03

### Added

- Finding explanations with explicit evidence links and missing-proof notes; bounded, compatible review comparison.
- Snapshot-only TypeScript semantic dependency analysis, including supported aliases and reexports.
- Lazy analysis worker with cancellation, progress, content limits and actual duration measurements.
- Check recommendations by impact, dependency comparability and declarative `.probato.yml` policies.
- Optional Stryker mutation testing with independent execution, verification, baseline, quality and gate states.
- Differential mutation gate, structured reports, bounded execution and explicit approval without mandatory Stryker.
- English and Spanish labels, CLI report comparison and optional mutation controls.

### Changed

- Open VSX publication and daily synchronization share `publish.yml` and its single Trusted Publisher registration.
- Open VSX CI uses OIDC and removes PAT precedence from trusted publication subprocesses.
- Architecture, readiness and roadmap documentation describe current guarantees and validation limits.

## [0.4.1] — 2026-11-03

### Fixed

- Translate risk levels in Home and history, check types, evidence details and GitHub state labels.
- Localize the welcome tagline, AI provider descriptions and authored integration errors.
- Check translation coverage and interpolation placeholders in the standard lint gate.

## [0.4.0] — 2026-11-03

### Added

- Persistent Home control center with repository status, review scopes, verification, GitHub delivery and history.
- First-visit welcome flow, direct sidebar access and a preference to control automatic opening.
- Validated User and Workspace settings inside Home, with separate values for each scope.
- Original Probato PR logo and green accent, responsive layouts, keyboard navigation and theme-aware surfaces.

## [0.3.0] — 2026-11-02

### Added

- GitHub delivery: create or update draft pull requests, publish selected findings, manage reviews and conversations,
  inspect CI logs, watch checks, merge with an expected head and destination, and enqueue pull requests.
- Explicit local Git actions: create/switch branches, stage selected files, commit, push, synchronize and remove
  merged local branches. Each mutation presents a confirmation and invalidates the prior local review.
- CLI with JSON, Markdown and SARIF output, severity exit codes, explicit check selection and SARIF import.
- Monorepo check discovery, isolated staged/historical verification and per-package dependency handling.
- Conservative cross-stack checks for OpenAPI JSON/YAML and TypeScript DTO properties, SQL column references
  and removed tenant predicates. Inferred relationships remain suspected.
- Opt-in review on save and bounded in-memory caching with consumer/configuration invalidation.

### Fixed

- Redact complete private-key blocks and human-readable fields at storage, export and AI boundaries.
- Keep analyzer/AI hypotheses separate from proven compiler diagnostics on the same source line.
- Bind verification and remembered approvals to repository content; reject changes during review or execution.
- Compare diagnostic occurrences conservatively and reject incomplete or incomparable baselines.
- Use the merge base for pull request analysis and validate every published inline location against its diff.
- Export textual SARIF suggestions without emitting invalid structured fixes.
- Recover history writes after a temporary storage failure.
- Disable configured checkout filters and hooks while creating isolated review worktrees.

## [0.2.1] — 2026-11-02

### Changed

- **Faster contract analysis on large change sets.** Reading the base and head version of each changed file (one `git`
  process per read) now overlaps instead of running one after another. Measured on generated repositories: 1,000 files /
  50 changed went from 3.6 s to 1.5 s, and 5,000 / 300 from 20.7 s to 8.8 s, with identical findings.
- The status-bar progress of a review now names the analyzer that is running.
- The release workflow verifies on macOS as well as Linux and Windows.

## [0.2.0] — 2026-11-02

### Added

- **Verification for PHP, Python, Rust and Java/Kotlin**, besides JavaScript/TypeScript and Go:
  - PHP: Composer scripts, or PHPStan, PHP_CodeSniffer, PHPUnit and Pest from `vendor/bin`.
  - Python: mypy, ruff and pytest when the project configures them, run with its virtual environment (`.venv`, `venv`,
    `env`) and only if installed there; otherwise with the interpreter on `PATH`, and the plan says so.
  - Rust: `cargo check`, `cargo clippy`, `cargo test`.
  - Java/Kotlin: Maven `compile`/`test` and Gradle `assemble`/`test`, through the committed `mvnw`/`gradlew` wrapper
    when there is one. The wrapper's content is part of the approval fingerprint.
- Compiler and linter errors from these tools are linked to findings at the same line (new `gnu` and `maven` output
  formats), so they can confirm a finding like `tsc` and `go` already did. Absolute paths inside the checked directory
  are understood.

### Changed

- Check detection is organized per ecosystem (`src/verification/ecosystems/`).

### Notes

- PHP and Python baselines do not reuse `vendor/` or the virtual environment on purpose: an autoloader or an editable
  install would load the changed code and produce a false attribution, so such failures are reported as inconclusive.

## [0.1.3] — 2026-11-02

### Added

- **Run and remember:** approved checks can run without asking again in the same repository. The approval is stored
  outside the repository and bound to a hash of the command, its directory and the script body, so any change asks
  again. New command *Forget Approved Checks*.
- **Always compare** in the base-revision question saves the choice in your user settings.
- Light-bulb actions on Probato PR diagnostics: dismiss the finding, show its evidence, open the Review Summary.

### Changed

- Markdown reports and the pull request description follow the VS Code display language, with readable check results and
  attributions ("Failed (Introduced by this change)" instead of "FAIL (introduced)").
- Evidence entries in the Verification view show the command first, where it ran ("with this change", "on the base
  revision") and a tooltip with commit, exit code and duration.

### Fixed

- With a non-English display language, checks that run repository scripts were pre-selected in the approval list.
  Pre-selection now relies on whether the check runs repository code, not on the warning text.

## [0.1.2] — 2026-11-02

### Fixed

- The review scope label (current changes, staged changes, branch changes since a branch, commit, pull request) follows
  the VS Code display language.
- Spanish finding titles for added items no longer disagree in gender ("Se agregó en archivo: elemento" instead of
  "elemento agregado").

### Added

- Screenshots in the README (Review Summary, findings with evidence status, check approval).

## [0.1.1] — 2026-11-02

### Fixed

- Finding titles and descriptions, verification notes, risk reasons, limitations, check details and progress messages
  now follow the VS Code display language (Spanish included). Previously they were always shown in English inside a
  Spanish UI. Finding ids do not depend on the language, so dismissed findings stay dismissed after switching it.

## [0.1.0] — 2026-11-02

First public release (Preview) on the Visual Studio Marketplace.

### Added

- Local review of current, staged, branch and commit changes; read-only GitHub pull request review.
- Deterministic analyzers: contracts (TS/JS AST), test integrity (TS/JS AST, Go line-level), secrets, error handling,
  dependencies, configuration.
- Evidence model with Confirmed / Evidenced / Suspected / Not verified classification.
- Verification engine: check detection, explicit approval, safe process execution (timeouts, cancellation, process-tree
  cleanup, output limits), command evidence, base-revision re-runs in temporary worktrees, regression attribution
  (introduced / pre-existing / fixed / inconclusive), linking of tool diagnostics to findings.
- Explainable review risk with reasons and limitations.
- Activity Bar views (Overview, Findings, Verification), editor diagnostics, finding dismissal, virtual report and
  evidence documents.
- Markdown, SARIF 2.1.0 and JSON reports.
- Optional AI review via the VS Code Language Model API or Anthropic Claude, with consent dialog, redaction,
  prompt-injection fencing and hallucination rejection.
- English and Spanish localization (manifest and runtime messages).
- Contract analysis resolves `tsconfig.json` `baseUrl` / `paths` aliases.
- Review commands accept a target repository: Source Control view button and multi-root support.
- Confirmation before reviewing a repository whose root is above the opened folder (e.g. a home directory under Git).
- Guided Review → Verify → Share flow shared by every surface: Review Summary panel (risk, next step, filterable
  findings, checks with evidence), step-based Overview view, persistent status bar entry and Activity Bar badge.
- Findings view grouping by severity or by file, and empty states with next actions in every view.
- Get Started walkthrough and the *Open Markdown Report (for the PR Description)* command.
- Localized check statuses and attributions (previously shown as raw identifiers).
- Brand mark: the letter P drawn as a merge graph.
- MIT License.
- Bring your own AI: *Connect Your AI* setup (VS Code chat models, Anthropic, OpenAI and any OpenAI-compatible API such
  as OpenRouter, Azure OpenAI, Ollama or LM Studio), models listed from the provider, keys bound to their server origin.
- Richer AI context: full content of changed files (optional) and already-known findings; the confirmation dialog lists
  every file and how it is shared.
- AI walkthrough of the change (overview, per-file summary, where to look first) shown in the Review Summary, the
  Markdown report and the new *Copy PR Description* command, which also works without AI.
- AI findings are upgraded to *confirmed* when an executed check fails at the same line only after the change ("AI
  suspicion confirmed").
- Marked as Preview in the Marketplace manifest.

### Changed

- *Set Anthropic API Key* replaced by *Connect Your AI* and *Delete Stored AI API Keys*.
