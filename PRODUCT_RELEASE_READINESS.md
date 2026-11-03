# Product release readiness — Probato PR 0.5.0

Assessment date: 2026-11-03. This document replaces the historical 0.1.0 release snapshot; old statements about one
webview, read-only GitHub access or promoting AI hypotheses from matching lines do not describe the current product.

## Current decision

**Packaged-host and remote acceptance pending.** The combined suite has passed 404 tests, TypeScript checks,
lint with 1084 complete translation keys, production build and CLI smoke. Release completion still requires
packaged Extension Host acceptance and the required remote checks.
No skipped or inconclusive check is treated as PASS.

## Evidence already obtained

| Area | Evidence | Qualification |
|---|---|---|
| Existing product | Baseline 0.4.1 had 269 unit tests and Linux/macOS/Windows CI verification. | Reuse only for unaffected behavior. |
| Policies and verification | Focused tests and the final combined 404-test suite passed. | Packaged host and remote checks pending. |
| Semantic contracts | Alias, reexport, ambiguity and snapshot tests passed; authored corpus expanded. | Not an independent comparative benchmark. |
| Worker | Five focused tests passed, including real RPC, Spanish labels, heartbeat and cancel/restart. | Final packaged Extension Host acceptance pending. |
| UI and history | Focused tests and the final combined 404-test suite passed. | Packaged host acceptance pending. |
| Performance | Existing three budgets passed; a 500-file sample measured 513.7 ms cold, 329.1 ms reused and 452.6 ms after correction. | Local sample, not a guarantee for other repositories. |
| Mutation execution | Final hardened Stryker 10.1.1 fixture passed: base 5 killed/2 survived; changed tests 3 killed/4 survived; atomic terminal emission and Markdown/JSON/SARIF exports checked. | Integrated release gate remains pending. |
| Open VSX | Installed CLI supports `--trusted-publishing`; focused publication tests passed. | Live publishing is not certified by a local test. |

## Final acceptance record

Before declaring this release complete, record:

1. Final commit and clean packaged-content inventory, including the analysis worker. The integrated production build
   measured a 1,234,507-byte activation bundle with no TypeScript compiler inputs.
2. TypeScript, lint/i18n, unit tests and applicable Extension Host results. Production build and CLI smoke passed
   during integration; final combined acceptance remains pending.
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

The exact final test counts and artifacts must be updated from actual run results, not inferred from this checklist.
