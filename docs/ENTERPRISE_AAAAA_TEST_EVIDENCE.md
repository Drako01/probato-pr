# Enterprise AAAAA upgrade — test evidence

Base commit: `9466260992e92604934fc4bc1679ef7a2a361aae` (`HEAD` = `origin/main`, verified 2026-11-08) plus uncommitted
Phase I working-tree changes. Platform: Windows 11 Pro 10.0.26320, local. No CI run exists for these changes yet.

| ID | Command | Result | Duration | Notes |
|---|---|---|---|---|
| E1 | `pnpm exec vitest run test/unit/quality-gate.test.ts test/unit/sarif-taxonomy.test.ts test/unit/cli-quality-gate.test.ts test/unit/ai-github-reports.test.ts test/unit/audit-hardening.test.ts` | PASS — 5 files, 68 tests | 8.6 s | Focused run after the SARIF and gate changes |
| E2 | `pnpm test` | PASS — 38 files, 444 tests, 0 skipped | 34.7 s | Includes the new `docs-consistency.test.ts`; internal corpus: 26 cases, precision 1.000, recall 1.000 (internal, not external validation) |
| E3 | `pnpm run typecheck` | PASS | 4.9 s | Extension and webview projects |
| E4 | `pnpm run lint` | PASS | 14.0 s | ESLint + l10n keys: 1098 keys, 0 missing/stale/invalid |

Not executed in this change: `pnpm run test:integration`, `pnpm run perf`, `test:mutation:e2e`, `build:prod`,
packaging, coverage. The changes do not touch `src/mutation/**` or `src/verification/**`, so mutation E2E is not
required by the policy; integration and packaging must run once on the integrated candidate.
