# Enterprise AAAAA upgrade — checklist

States: `TODO` · `IN_PROGRESS` · `PASS` · `WARN` · `BLOCKED`. Evidence references
[ENTERPRISE_AAAAA_TEST_EVIDENCE.md](ENTERPRISE_AAAAA_TEST_EVIDENCE.md). Commit column stays empty until the change is committed.

## Phase I — semantic integrity, contracts, P1

| ID | Task | State | Evidence | Commit | Acceptance |
|---|---|---|---|---|---|
| I.1 | Typed rule taxonomy; SARIF `security-severity` only on security rules, `problem.severity` elsewhere (P1-01) | PASS | E1, E2 (`sarif-taxonomy.test.ts`, 5 tests) | c830af6 | 0 non-security rules with `security-severity`; every shipped rule ID classified |
| I.2 | SARIF validated against the official 2.1.0 JSON schema and GitHub fixtures | PASS | E11 (`sarif-schema.test.ts`, 12 tests: 5 fixtures × with/without gate, formats `uri`/`uri-reference`/`date-time`, GitHub upload constraints, stable fingerprints, redaction, importer round trip) | Phase I closing commit | OASIS schema vendored unmodified and pinned by SHA-256; dev-only `ajv` 8.20.0 + `ajv-draft-04` 1.0.0. The schema caught a duplicate `security` tag introduced earlier in this branch (c830af6), fixed. GitHub Code Scanning is checked statically, not by a live upload |
| I.3 | Gate modes `absolute`/`regression-only`/`hybrid` + `--on-inconclusive` (P1-03) | PASS | E1, E2 (`quality-gate.test.ts`, 31 tests: 28-row truth table) | c830af6 | Default behavior identical to 0.6.0 (checked against `reportExitCode` for 5 thresholds) |
| I.4 | Gate decision surfaced in JSON/SARIF reports (not only stderr) | PASS | E11 (`sarif-schema.test.ts`, `cli-quality-gate.test.ts` real CLI run) | Phase I closing commit | Additive optional `qualityGate` (JSON) / `runs[0].properties.qualityGate` (SARIF) for differential modes; `REPORT_SCHEMA_VERSION` stays 1 because history readers are `loose()`; `absolute` reports unchanged. Markdown keeps the stderr explanation only |
| I.5 | SECURITY/PRIVACY/README/manual plan truthful about GitHub and Git writes and approval UI (P1-02) | PASS | E2 (`docs-consistency.test.ts`) | 6ea5a84 | No contradiction between `GitHubDelivery` writes and SECURITY.md |
| I.6 | `PRODUCT_RELEASE_READINESS.md` updated for 0.6.0/0.7.0 candidate (P2-06) | PASS | GO/NO-GO table for the 0.7.0 candidate (verdict NO-GO), 0.5.0 record kept as history | Phase I closing commit | Every open blocker listed as BLOCKED/FAIL/WARN, none counted as PASS |

## Phase II — precision and external benchmark

| ID | Task | State | Evidence |
|---|---|---|---|
| II.1 | Internal corpus (26 cases / 11 traps) kept as regression test, not external validation | PASS | E2 (`benchmark.test.ts`) |
| II.2 | External benchmark ≥600 cases, ≥20 repos, holdout (P1-04) | BLOCKED | Needs licensed real-world material and human ground-truth labeling; no synthetic filler will be used |

## Phase III — architecture, coverage, deep tests

| ID | Task | State |
|---|---|---|
| III.1 | Split `review-controller`, `delivery-controller`, `home-panel`, `github/delivery`, `mutation/engine`, `ts-contracts` along functional boundaries | TODO |
| III.2 | Vitest coverage with per-module thresholds (P2-01) | WARN — E6: `@vitest/coverage-v8` 5.1.0, `pnpm run test:coverage`, per-module gate `scripts/coverage-modules.mjs` (floors = measured baseline, wired into CI Linux without a second test pass). Target 85/80 met by `core`, `verification`, `github`; branch coverage of `git` (73.3%) and `mutation` (74.6%) is below 80% |
| III.3 | Property-based/fuzz tests (diff parser, paths, refs, CLI, SARIF, redaction) | IN_PROGRESS — E8 `property-based.test.ts` (seeded, 300 cases per property, `PROBATO_FUZZ_SEED` to reproduce): git path quoting round trip, diff parser line numbers/counts/robustness, secret redaction (no leak, idempotent, no false rewrite). Refs, CLI arguments, SARIF and AI-result parsing still TODO; no automatic shrinking |
| III.4 | Fault injection (cancellation, worktree cleanup, corrupt persistence) | TODO |

## Phase IV — security and supply chain

| ID | Task | State |
|---|---|---|
| IV.1 | Threat model update for write operations, AI providers, webviews | TODO |
| IV.2 | Adversarial test suite (refs, `.cmd`, git filters, traversal/TOCTOU, SSRF, XSS, prompt injection) | TODO |
| IV.3 | Optional isolated execution backend (container, no network) or explicit `unavailable` | TODO |
| IV.4 | SBOM, VSIX integrity/provenance, Dependabot failure triage of 2026-11-07 (P2-07) | IN_PROGRESS — open alert #3 triaged (E9): GHSA-g3hv-75wg-m249, `minimatch` 10.2.6, **development scope only** (eslint, vsce/ovsx, mocha), not bundled in the VSIX; fix is 11.0.1, a major version outside what those tools declare. Third-party policy: WARN, no forced override (risk of breaking lint/packaging for a DoS through developer-controlled glob patterns). VSIX checksum between jobs done (V.4); SBOM and provenance attestation TODO |

## Phase V — CI/CD, release, performance

| ID | Task | State |
|---|---|---|
| V.1 | Split `ci.yml` / `publish.yml`; no duplicate QA on `push(main)` (P1-06) | PASS — E5 `workflow-contract.test.ts`; `ci.yml` ran green on PR #16 with the required check names (E10); `publish.yml` did not run on the PR. The push(main) path is only verified statically until the next merge. `push(main)` without a version change runs only the plan job; a version change runs one release gate on the merged tree because V.2 is open |
| V.2 | Strict required checks or merge queue | BLOCKED — ruleset `26362018` has `strict_required_status_checks_policy=false` (read with `gh api repos/Drako01/probato-pr/rules/branches/main`). Changing it needs explicit maintainer authorization. `ci.yml` already listens to `merge_group` |
| V.3 | Mutation E2E gated on relevant paths (P1-05) | PASS — `Mutation E2E` job in `ci.yml` ran real Stryker in CI (E10); skipped otherwise with an explicit summary line. Not a required check (adding it needs a ruleset change) |
| V.4 | Single SHA-256-identified VSIX to Marketplace/Open VSX/Release | PASS (static) — one `vsce package`, manifest version check, `sha256sum -c` in every consumer job (E5). Build provenance attestation: TODO |
| V.5 | P50/P95 and peak RSS on real repositories (P2-04) | TODO |

## Phase VI — UX, accessibility, acceptance

| ID | Task | State |
|---|---|---|
| VI.1 | Distinct evidence/attribution states in Home/Summary; PASS/NEUTRAL/SKIPPED checks (P2-05) | TODO |
| VI.2 | WCAG 2.2 AA audit on packaged VSIX | TODO |
| VI.3 | Extension Host on Windows/macOS; Remote SSH/WSL/Dev Containers | TODO (only Linux runs today, P2-02) |
| VI.4 | Final screenshots and release documents | TODO |
