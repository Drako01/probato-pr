# Enterprise AAAAA upgrade — plan

AAAAA is an internal quality target, not an external certification. Baseline: `main` @ `9466260992e92604934fc4bc1679ef7a2a361aae`
(0.6.0), audit of 2026-11-08 rated 76/100. Status of every task lives in
[ENTERPRISE_AAAAA_UPGRADE_CHECKLIST.md](ENTERPRISE_AAAAA_UPGRADE_CHECKLIST.md); command evidence in
[ENTERPRISE_AAAAA_TEST_EVIDENCE.md](ENTERPRISE_AAAAA_TEST_EVIDENCE.md).

## Principles

Additive changes only; 0.6.0 contracts (commands, settings, CLI defaults and exit codes, JSON/SARIF shape, history) stay
compatible. No new frameworks or layers without a demonstrated need. SKIP/WARN/INCONCLUSIVE are never reported as PASS.

## Phase I — semantic integrity and P1 fixes (implemented in this change)

| Decision | Where | Why |
|---|---|---|
| One rule taxonomy (`security`, `correctness`, `test-integrity`, `maintainability`, `external`, `ai-hypothesis`) | `src/core/rule-taxonomy.ts` | Single source of truth; unknown, external and AI rules can never be classified as security (fail closed). |
| SARIF: `security-severity` + CWE tags only for security rules; `problem.severity` for the rest; rule severity = most severe finding of the run | `src/reports/sarif.ts` | GitHub reserves `security-severity` for security rules. `precision` is omitted until an external benchmark exists. |
| Quality gate as a pure domain function with modes `absolute` (default, 0.6.0), `regression-only`, `hybrid` and `--on-inconclusive fail\|warn` | `src/core/quality-gate.ts`, `src/cli.ts` | Pre-existing failures no longer block a differential gate; heuristic/AI findings never block it alone; missing baseline never yields PASS. `reportExitCode` is kept and delegates to `absolute`. |
| Truthful permissions | `SECURITY.md`, `PRIVACY.md`, `README.md`, `docs/MANUAL_TEST_PLAN.md` | Documents every GitHub and local Git write and what the approval UI really shows. |
| Doc/implementation guard | `test/unit/docs-consistency.test.ts` | Fails when a `GitHubDelivery` write method is undocumented or a known false claim returns. |

Exit-code precedence (all modes): execution error/incomplete (2) > demonstrated failure (1) > inconclusive attribution
(2 or WARN by policy) > WARN (0) > PASS (0).

## Phases II–VI — not started in this change

Order and dependencies: II (external benchmark) needs licensed real-world material and labeling time; III (refactors,
coverage, property/fault tests) should precede IV (adversarial tests, optional container sandbox, SBOM); V (CI split,
merge queue/strict checks, single-VSIX publish, perf P95) requires a ruleset decision from the maintainer; VI (UX states,
WCAG 2.2 AA, Extension Host on Win/macOS, screenshots) closes. See the checklist for the per-task state.
