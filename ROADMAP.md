# Roadmap

Priorities follow the product principle: precision and proof over volume.

## 0.1 — MVP (current)

Local and PR review, deterministic analyzers, verification engine with baseline attribution, evidence model, reports, optional AI. See [CHANGELOG](CHANGELOG.md).

## 0.2 — Release hardening

- Verify and document Linux, macOS, WSL, Dev Containers and Remote SSH (CI matrix prepared in `docs/ci/`, not enabled).
- Resolve `tsconfig` `paths` aliases and workspace package imports in contract analysis.
- Per-package baselines for monorepos (pnpm/yarn workspaces).
- Spanish runtime localization bundle complete.
- Screenshots and short demo for the Marketplace listing.

## 0.3 — Cross-stack review

- **Case A (API ↔ client):** detect renamed response properties in backend DTOs/OpenAPI and stale usages in frontend code, then confirm with the type-check or contract tests.
- **Case B (multi-tenancy):** flag new data-access code that queries by ID without the tenant predicate used elsewhere in the repository, and link existing isolation tests.
- **Case C (migrations):** SQL migrations dropping or renaming columns still referenced by queries/ORM models.
- **Case D (CI green, flow broken):** map changed files to existing integration tests and run them selectively.

## 0.4 — More languages and tools

PHP, Python, Java analyzers with real parsers; PostgreSQL/MySQL migrations; OpenAPI; Docker and Terraform configuration checks; SARIF import from existing linters as evidence.

## Later

- Draft GitHub review comments (never posted without explicit approval of exact content and target PR).
- Isolated, approval-gated generation of regression tests.
- Incremental re-review on save.
- Opt-in, disabled-by-default telemetry, only if it is needed and documented.
- Web (`vscode.dev`) support limited to diff analysis, if the architecture allows it without weakening local verification.
