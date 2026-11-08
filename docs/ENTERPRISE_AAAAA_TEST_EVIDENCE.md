# Enterprise AAAAA upgrade — test evidence

Base commit: `9466260992e92604934fc4bc1679ef7a2a361aae` (`HEAD` = `origin/main`, verified 2026-11-08) plus uncommitted
Phase I working-tree changes. Platform: Windows 11 Pro 10.0.26320, local. No CI run exists for these changes yet.

| ID | Command | Result | Duration | Notes |
|---|---|---|---|---|
| E1 | `pnpm exec vitest run test/unit/quality-gate.test.ts test/unit/sarif-taxonomy.test.ts test/unit/cli-quality-gate.test.ts test/unit/ai-github-reports.test.ts test/unit/audit-hardening.test.ts` | PASS — 5 files, 68 tests | 8.6 s | Focused run after the SARIF and gate changes |
| E2 | `pnpm test` | PASS — 38 files, 444 tests, 0 skipped | 34.7 s | Includes the new `docs-consistency.test.ts`; internal corpus: 26 cases, precision 1.000, recall 1.000 (internal, not external validation) |
| E3 | `pnpm run typecheck` | PASS | 4.9 s | Extension and webview projects |
| E4 | `pnpm run lint` | PASS | 14.0 s | ESLint + l10n keys: 1098 keys, 0 missing/stale/invalid |
| E5 | `pnpm exec vitest run test/unit/workflow-contract.test.ts` + `pnpm exec eslint test/unit/workflow-contract.test.ts` | PASS — 4 tests; lint clean | 0.7 s | Phase V CI/publish split. Static contract only: workflows have not run on GitHub yet |
| E6 | `pnpm exec vitest run --coverage` then `node scripts/coverage-modules.mjs` | PASS — 39 files, 448 tests, 0 skipped. Global: lines 64.42%, branches 58.80% (includes untested UI/extension layers). Per module lines/branches: core 90.1/84.1 PASS, verification 94.6/83.7 PASS, git 90.9/73.3 WARN, github 95.6/80.4 PASS, mutation 91.4/74.6 WARN | 35.9 s | Windows 11, local, after commit `bad14f0` plus the coverage change |
| E7 | `pnpm run lint` | PASS — 1098 l10n keys, 0 missing | 12.6 s | `pnpm peers check` reports a pre-existing unmet peer (`vitest@5.1.0` wants `@types/node` ^22, installed 20.19.43), not introduced by the coverage provider |
| E8 | `pnpm exec vitest run test/unit/property-based.test.ts` + `eslint` + `pnpm run typecheck` | PASS — 5 properties × 300 cases, seed 20261108; lint and typecheck clean | 1.0 s | No defect found by these generators with this seed |

Not executed in this change: `pnpm run test:integration`, `pnpm run perf`, `test:mutation:e2e`, `build:prod`,
packaging, coverage. The changes do not touch `src/mutation/**` or `src/verification/**`, so mutation E2E is not
required by the policy; integration and packaging must run once on the integrated candidate.
