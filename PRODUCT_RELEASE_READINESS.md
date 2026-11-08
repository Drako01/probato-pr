# Product release readiness — Probato PR

Published version: **0.6.0**. Candidate: **1.0.0** (manifest bumped on 2026-11-08 by maintainer decision; publication
happens when the PR merges into `main`). Assessment date: 2026-11-08, branch
`feat/enterprise-aaaaa-upgrade` (PR #16). Detailed evidence lives in
[docs/ENTERPRISE_AAAAA_TEST_EVIDENCE.md](docs/ENTERPRISE_AAAAA_TEST_EVIDENCE.md), task status in
[docs/ENTERPRISE_AAAAA_UPGRADE_CHECKLIST.md](docs/ENTERPRISE_AAAAA_UPGRADE_CHECKLIST.md) and the scored re-audit in
[docs/ENTERPRISE_AAAAA_FINAL_AUDIT.md](docs/ENTERPRISE_AAAAA_FINAL_AUDIT.md); this page only keeps the decision.

## Current decision — 1.0.0 candidate: **NO-GO until manual acceptance**

The maintainer chose to version this release as 1.0.0 and to run the installed-VSIX acceptance (accessibility,
Windows/macOS Extension Host, remote hosts) personally. The rows still BLOCKED or FAIL below remain open until that
evidence exists; the external benchmark remains a documented limitation, not a claim. Any critical blocker means NO-GO. States: PASS / WARN / FAIL / SKIP / BLOCKED; nothing skipped or inconclusive is
counted as PASS.

| Gate | State | Evidence / reason |
|---|---|---|
| SARIF 2.1.0 valid against the official OASIS schema; taxonomy (no `security-severity` on quality rules) | PASS | `sarif-schema.test.ts`, `sarif-taxonomy.test.ts` |
| Differential quality gate (`absolute` default = 0.6.0, `regression-only`, `hybrid`) with exit contract 0/1/2 and decision in JSON/SARIF | PASS | `quality-gate.test.ts` (truth table), `cli-quality-gate.test.ts` |
| Truthful security/privacy documentation of GitHub and Git writes | PASS | `docs-consistency.test.ts` |
| Typecheck, lint, l10n keys, unit/engine suite, production build (local, Windows) | PASS | Evidence E11 |
| PR validation split from publishing; one checksummed VSIX | PASS | CI run on PR #16 (E10) |
| Independent external precision/recall benchmark (≥600 cases, holdout) | BLOCKED | Needs licensed real-world data with human ground truth; the authored corpus (71 cases, 36 traps, sealed holdout, per-rule metrics with Wilson CIs — `docs/BENCHMARK.md`) is a regression test only |
| Merge-candidate protection (strict required checks or merge queue) | PASS (static) | Ruleset `26362018` has `strict_required_status_checks_policy=true` (read with `gh api`, 2026-11-08); `publish.yml` proves tree identity + green Verify checks before skipping the post-merge gate (`workflow-contract.test.ts`). First real run happens at the next version-changing merge |
| Extension Host on Windows/macOS; Remote SSH/WSL/Dev Containers | BLOCKED | Only Linux Extension Host runs in CI |
| Threat model update, adversarial suite, SBOM/provenance, Dependabot alert #3 | PASS | `docs/THREAT_MODEL.md`, `adversarial.test.ts` (two real defects fixed), SBOM + attestation in `publish.yml`, `minimatch` override (checklist IV.1, IV.2, IV.4) |
| Optional isolated execution backend | WARN | Not implemented; the runner is documented as not a sandbox (checklist IV.3) |
| Required vs informative CI checks; neutral/skipped never shown as pass | PASS | `github-delivery.test.ts` (checklist VI.1) |
| Per-module coverage ≥85% lines / ≥80% branches | WARN | `git` and `mutation` branch coverage below 80% |
| Accessibility audit (WCAG 2.2 AA) on packaged VSIX, final screenshots | BLOCKED | Manual acceptance on the installed VSIX, owned by the maintainer; screenshots are the labeled 0.4.0 captures |
| Performance P50/P95 and peak memory on real repositories | PASS (one machine) | `pnpm run perf:real`, 60 runs on Windows 11 (`docs/evidence/`, checklist V.5); other OSes not measured |

## Previous acceptance record — 0.5.0 (2026-11-03)

This record replaced the historical 0.1.0 release snapshot; old statements about one webview, read-only GitHub access
or promoting AI hypotheses from matching lines do not describe the current product.

**Local acceptance recorded; merging requires the exact-head GitHub checks.** The combined suite passed 404 tests,
TypeScript, lint with 1084 complete translation keys, production build and CLI smoke. The subsequent POSIX snapshot
fix passed all 10 affected mutation-engine tests. The extracted VSIX passed 12 real Extension Host tests.
Remote checks and publication are recorded separately in the pull request and release workflow.
No skipped or inconclusive check is treated as PASS.

### Evidence (0.5.0)

| Area | Evidence | Qualification |
|---|---|---|
| Existing product | Baseline 0.4.1 had 269 unit tests and Linux/macOS/Windows CI verification. | Reuse only for unaffected behavior. |
| Policies and verification | Focused tests and the final combined 404-test suite passed. | Exact-head remote checks are required before merge. |
| Semantic contracts | Alias, reexport, ambiguity and snapshot tests passed; authored corpus expanded. | Not an independent comparative benchmark. |
| Worker | Five focused tests passed, including real RPC, Spanish labels, heartbeat and cancel/restart. | Extracted VSIX: 8 single-repository and 4 multi-root tests passed. |
| UI and history | Focused tests and the final combined 404-test suite passed. | Extracted VSIX: 12 tests passed. |
| Performance | Existing three budgets passed; a 500-file sample measured 513.7 ms cold, 329.1 ms reused and 452.6 ms after correction. | Local sample, not a guarantee for other repositories. |
| Mutation execution | Final hardened Stryker 10.1.1 fixture passed: base 5 killed/2 survived; changed tests 3 killed/4 survived; atomic terminal emission and Markdown/JSON/SARIF exports checked. | Integrated release gate remains pending. |
| Open VSX | Installed CLI supports `--trusted-publishing`; focused publication tests passed. | Live publishing is not certified by a local test. |

### Final acceptance record (0.5.0)

The local acceptance record is:

1. VSIX inventory: 26 files, 3.77 MB, including the analysis worker and optional mutation runtime. The production
   build measured a 1,234,507-byte activation bundle with no TypeScript compiler inputs.
2. TypeScript, lint/i18n, 404 integrated unit tests, production build, CLI smoke and 12 packaged Extension Host tests
   passed. The later POSIX dependency-link fix passed its 10 affected tests; remote runs certify the final total.
3. The final real mutation E2E passed with source/dependency/configuration identities and exported reports. Command:
   `pnpm run test:mutation:e2e` with the explicit opt-in and prepared fixture variables in the mutation guide. The 58
   mutation unit tests passed.
4. Regression 85% → 78% as −7 percentage points; non-comparable data must not produce a demonstrated delta.
5. Engine failures, timeouts, cancellation and missing-tool results, with independent gate decisions.
6. Markdown and manifest localization coverage, and confirmation that existing README images were preserved.
7. Required remote CI and publication state separately from local checks.

## Known limits

- Mutation support initially requires existing local Stryker and JSON configuration; no automatic installation.
- In-flight Git setup observes its own timeout before cancellation; resource limits are not an OS sandbox.
- An authored corpus does not establish real-world precision or superiority to another tool.
- Unsupported dependency environments and semantic graphs remain inconclusive or conservative.
- Remote SSH, WSL, Dev Containers, screen-reader acceptance and live AI-provider calls are separate validation.
- Naming, trademark and legal availability were not reassessed in this technical upgrade.

The PR checks certify the exact merge candidate. A successful local check does not certify Marketplace or Open VSX
authentication; those results belong to the authorized release workflow.
