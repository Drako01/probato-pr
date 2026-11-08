# Enterprise AAAAA upgrade — checklist

States: `TODO` · `IN_PROGRESS` · `PASS` · `WARN` · `BLOCKED`. Evidence references
[ENTERPRISE_AAAAA_TEST_EVIDENCE.md](ENTERPRISE_AAAAA_TEST_EVIDENCE.md). Commit column stays empty until the change is committed.

## Phase I — semantic integrity, contracts, P1

| ID | Task | State | Evidence | Commit | Acceptance |
|---|---|---|---|---|---|
| I.1 | Typed rule taxonomy; SARIF `security-severity` only on security rules, `problem.severity` elsewhere (P1-01) | PASS | E1, E2 (`sarif-taxonomy.test.ts`, 5 tests) | c830af6 | 0 non-security rules with `security-severity`; every shipped rule ID classified |
| I.2 | SARIF validated against the official 2.1.0 JSON schema and GitHub fixtures | TODO | — | — | Requires adding a schema validator dependency and the vendored schema; not done |
| I.3 | Gate modes `absolute`/`regression-only`/`hybrid` + `--on-inconclusive` (P1-03) | PASS | E1, E2 (`quality-gate.test.ts`, 31 tests: 28-row truth table) | c830af6 | Default behavior identical to 0.6.0 (checked against `reportExitCode` for 5 thresholds) |
| I.4 | Gate decision surfaced in JSON/SARIF reports (not only stderr) | TODO | — | — | Needs a versioned optional report field |
| I.5 | SECURITY/PRIVACY/README/manual plan truthful about GitHub and Git writes and approval UI (P1-02) | PASS | E2 (`docs-consistency.test.ts`) | — | No contradiction between `GitHubDelivery` writes and SECURITY.md |
| I.6 | `PRODUCT_RELEASE_READINESS.md` updated for 0.6.0/0.7.0 candidate (P2-06) | TODO | — | — | — |

## Phase II — precision and external benchmark

| ID | Task | State | Evidence |
|---|---|---|---|
| II.1 | Internal corpus (26 cases / 11 traps) kept as regression test, not external validation | PASS | E2 (`benchmark.test.ts`) |
| II.2 | External benchmark ≥600 cases, ≥20 repos, holdout (P1-04) | BLOCKED | Needs licensed real-world material and human ground-truth labeling; no synthetic filler will be used |

## Phase III — architecture, coverage, deep tests

| ID | Task | State |
|---|---|---|
| III.1 | Split `review-controller`, `delivery-controller`, `home-panel`, `github/delivery`, `mutation/engine`, `ts-contracts` along functional boundaries | TODO |
| III.2 | Vitest coverage with per-module thresholds (P2-01) | TODO |
| III.3 | Property-based/fuzz tests (diff parser, paths, refs, CLI, SARIF, redaction) | TODO |
| III.4 | Fault injection (cancellation, worktree cleanup, corrupt persistence) | TODO |

## Phase IV — security and supply chain

| ID | Task | State |
|---|---|---|
| IV.1 | Threat model update for write operations, AI providers, webviews | TODO |
| IV.2 | Adversarial test suite (refs, `.cmd`, git filters, traversal/TOCTOU, SSRF, XSS, prompt injection) | TODO |
| IV.3 | Optional isolated execution backend (container, no network) or explicit `unavailable` | TODO |
| IV.4 | SBOM, VSIX integrity/provenance, Dependabot failure triage of 2026-11-07 (P2-07) | TODO |

## Phase V — CI/CD, release, performance

| ID | Task | State |
|---|---|---|
| V.1 | Split `ci.yml` / `publish.yml`; no duplicate QA on `push(main)` (P1-06) | TODO |
| V.2 | Strict required checks or merge queue | BLOCKED — ruleset change needs explicit maintainer authorization |
| V.3 | Mutation E2E gated on relevant paths (P1-05) | TODO |
| V.4 | Single SHA-256-identified VSIX to Marketplace/Open VSX/Release | TODO |
| V.5 | P50/P95 and peak RSS on real repositories (P2-04) | TODO |

## Phase VI — UX, accessibility, acceptance

| ID | Task | State |
|---|---|---|
| VI.1 | Distinct evidence/attribution states in Home/Summary; PASS/NEUTRAL/SKIPPED checks (P2-05) | TODO |
| VI.2 | WCAG 2.2 AA audit on packaged VSIX | TODO |
| VI.3 | Extension Host on Windows/macOS; Remote SSH/WSL/Dev Containers | TODO (only Linux runs today, P2-02) |
| VI.4 | Final screenshots and release documents | TODO |
