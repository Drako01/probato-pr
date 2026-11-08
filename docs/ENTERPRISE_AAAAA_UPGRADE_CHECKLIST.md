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
| II.1 | Authored corpus kept as regression test, not external validation; expanded from 26 cases / 11 traps to 71 / 36 with provenance, language, tags and trap `guards` | PASS | E12 (`benchmark.test.ts`, corpus `probato-authored@2`) |
| II.2 | External benchmark ≥600 cases, ≥20 repos, holdout (P1-04) | BLOCKED | Needs licensed real-world material and human ground-truth labeling; no synthetic filler will be used. The harness (II.3) accepts external cases with repository/commit/license/path provenance |
| II.3 | Versioned benchmark harness: hash-derived dev/validation/holdout split, sealed holdout, per-rule/per-language/per-split precision, recall, F1, Wilson 95% CI, FP per case, inconclusive rate, JSON report | PASS | E12 (`benchmark-harness.test.ts`, `benchmark.test.ts`); methodology in `docs/BENCHMARK.md` |
| II.4 | Every analyzer rule has a positive and a negative case, or is an explicit gap | WARN | E12: 32 of 37 analyzer rules covered both ways; 5 secret formats (`anthropic-key`, `openai-key`, `stripe-live-key`, `google-api-key`, `jwt`) listed in `KNOWN_GAPS`. Rule catalog checked against analyzer sources |
| II.5 | AI evaluated as an isolated hypothesis; injection cannot raise certainty | PASS | Existing tests (`ai-github-reports.test.ts`: never `confirmed`, injection scrubbed; `quality-gate.test.ts`: heuristic/AI never block a differential gate alone). AI is excluded from deterministic metrics by design; no AI precision is claimed (needs a live provider) |

## Phase III — architecture, coverage, deep tests

| ID | Task | State |
|---|---|---|
| III.1 | Split `review-controller`, `delivery-controller`, `home-panel`, `github/delivery`, `mutation/engine`, `ts-contracts` along functional boundaries | WARN — E13. Split where a boundary existed: check approval and baseline prompts → `extension/verification-prompts.ts`; command error presentation → `extension/command-errors.ts`; exclusive cancellable progress shared by both controllers → `extension/exclusive-progress.ts` (removes a duplicate); check ranking → `verification/check-impact.ts#rankChecks` (pure, tested); mutation limits/gate merge → `mutation/run-config.ts` (pure, tested: a repository policy cannot change the resource budget). `review-controller.ts` 789 → 654 lines; command IDs and behavior unchanged. Not split, on purpose: `home-panel` (239), `github/delivery` (242), `mutation/engine` (204) have no second responsibility worth a module; `ts-contracts` (490) is a stable analyzer covered by the benchmark, and splitting it without a functional boundary would risk regressions for no measurable gain |
| III.2 | Vitest coverage with per-module thresholds (P2-01) | WARN — E6, E13: per-module gate `scripts/coverage-modules.mjs` (floors ratchet to the measured baseline, CI Linux). `core` 90.4/84.9, `verification` 94.7/83.5, `github` 95.6/80.8 PASS; `git` 91.5/**75.6** and `mutation` 91.5/**75.0** below the 80% branch target (WARN, not hidden). `git` floor raised to 91/74 |
| III.3 | Property-based/fuzz tests (diff parser, paths, refs, CLI, SARIF, redaction, AI parsing) | PASS — E8, E13: shared seeded generator `test/unit/fuzz.ts` (300 cases per property, `PROBATO_FUZZ_SEED` to reproduce, size grows with the case index so the first failing index is the smallest counterexample; no automatic shrinking). Properties: git path quoting round trip; diff parser counts/line numbers/robustness; redaction (no leak, idempotent, no false rewrite); git ref validation (accept alphabet, reject options/ranges/shell/control chars); AI response parsing (never throws, never raises certainty, anchors only to added lines); CLI arguments (domain closure, order independence, unknown options refused); SARIF export (schema-valid, no non-security `security-severity`, stable unique fingerprints, no secret). Found and fixed: inherited keys such as `constructor` classified an external rule as security in `classifyRule` (`Object.hasOwn`) |
| III.4 | Fault injection (cancellation, process tree, worktree cleanup, memory limit, timeout, partial API error, worker crash, corrupt persistence) | PASS — E13: worktree cleanup with `git worktree remove` failing, and remove + prune both failing (directory still deleted, every failure reported, typed `AggregateError` via `core/errors.ts`, no `only-throw-error` lint); analysis worker heap limit (`resourceLimits`, default 2048 MB, fresh worker afterwards); partial GitHub failure (PATCH applied, review POST fails → error reported, retry neither re-edits nor duplicates, POST never auto-retried). Already covered and re-run: process tree kill on cancel and timeout (`process-runner.test.ts`), worker exit and deadline (`analyzer-worker.test.ts`), corrupt and unwritable history (`resilience.test.ts`, `audit-hardening.test.ts`), mutation timeout/cancel/error terminal states (`mutation-engine.test.ts`) |

## Phase IV — security and supply chain

| ID | Task | State |
|---|---|---|
| IV.1 | Threat model update for write operations, AI providers, webviews | PASS — `docs/THREAT_MODEL.md`: assets, attackers, 18 threats each mapped to control, test evidence and residual risk; linked from SECURITY.md |
| IV.2 | Adversarial test suite (refs, `.cmd`, git filters, traversal/TOCTOU, SSRF, XSS, prompt injection) | PASS — E14 `adversarial.test.ts` (36 cases) plus the existing suites referenced per threat. **Two real defects found and fixed:** (1) the OpenAI-compatible provider followed HTTP redirects, so a 307/308 resent repository data to an unchecked host, even over plain http (now `redirect: 'manual'`, 3xx is an error; a real attacker server receives nothing); (2) `resolveInside` returned the lexical path for a non-existent file below a parent symlinked outside the repository (now resolves the nearest existing ancestor) |
| IV.3 | Optional isolated execution backend (container, no network) or explicit `unavailable` | WARN — not implemented. The runner is documented as **not a sandbox** (SECURITY.md, THREAT_MODEL T13, accepted risk with explicit approval and script-body binding). A container backend needs Docker on the user's machine, which the product directive forbids as a requirement; building it as an optional mode is left for a later release |
| IV.4 | SBOM, VSIX integrity/provenance, Dependabot failure triage of 2026-11-07 (P2-07) | IN_PROGRESS — open alert #3 triaged (E9): GHSA-g3hv-75wg-m249, `minimatch` 10.2.6, **development scope only** (eslint, vsce/ovsx, mocha), not bundled in the VSIX; fix is 11.0.1, a major version outside what those tools declare. Third-party policy: WARN, no forced override (risk of breaking lint/packaging for a DoS through developer-controlled glob patterns). VSIX checksum between jobs done (V.4); CycloneDX 1.7 SBOM of runtime dependencies (`pnpm run sbom`, 11 components, generated locally on 2026-11-08) attached to every GitHub release; signed build provenance attestation of the VSIX (V.4) |

## Phase V — CI/CD, release, performance

| ID | Task | State |
|---|---|---|
| V.1 | Split `ci.yml` / `publish.yml`; no duplicate QA on `push(main)` (P1-06) | PASS — E5 `workflow-contract.test.ts`; `ci.yml` ran green on PR #16 with the required check names (E10); `publish.yml` did not run on the PR. The push(main) path is only verified statically until the next merge. `push(main)` without a version change runs only the plan job; a version change runs one release gate on the merged tree because V.2 is open |
| V.2 | Strict required checks or merge queue | PASS (static) — the maintainer enabled strict required checks: ruleset `26362018` now reads `strict_required_status_checks_policy=true` (`gh api repos/Drako01/probato-pr/rules/branches/main`, 2026-11-08). `publish.yml` plan job compares the pushed tree with the merged PR head tree and requires 3 successful `Verify (…)` check runs on that head; only otherwise does the release gate run (E5, `workflow-contract.test.ts`). Not exercised live until the next version-changing merge |
| V.3 | Mutation E2E gated on relevant paths (P1-05) | PASS — `Mutation E2E` job in `ci.yml` ran real Stryker in CI (E10); skipped otherwise with an explicit summary line. Not a required check (adding it needs a ruleset change) |
| V.4 | Single SHA-256-identified VSIX to Marketplace/Open VSX/Release | PASS (static) — one `vsce package`, manifest version check, `sha256sum -c` in every consumer job (E5). Signed build provenance (`actions/attest-build-provenance` v4.2.2, SHA-pinned) on the same VSIX; verification command in `docs/RELEASE.md`. Live attestation not produced yet (needs a publishing run) |
| V.5 | P50/P95 and peak RSS on real repositories (P2-04) | TODO |

## Phase VI — UX, accessibility, acceptance

| ID | Task | State |
|---|---|---|
| VI.1 | Distinct evidence/attribution states in Home/Summary; PASS/NEUTRAL/SKIPPED checks (P2-05) | TODO |
| VI.2 | WCAG 2.2 AA audit on packaged VSIX | TODO |
| VI.3 | Extension Host on Windows/macOS; Remote SSH/WSL/Dev Containers | TODO (only Linux runs today, P2-02) |
| VI.4 | Final screenshots and release documents | TODO |
