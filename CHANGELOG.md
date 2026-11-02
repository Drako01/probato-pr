# Changelog

All notable changes to Probato PR are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

First functional version (not published).

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
