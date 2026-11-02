# Contributing

## Setup

- Node.js 22.12+ and pnpm 12 (`corepack enable`).
- Git on `PATH`.

```bash
pnpm install
pnpm run verify
```

## Project rules

- TypeScript `strict` (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any`.
- `src/core`, `src/analyzers`, `src/git`, `src/verification`, `src/reports`, `src/github` and `src/infrastructure` must not import `vscode` (enforced by `test/unit/ai-github-reports.test.ts`). No import cycles (same test).
- Processes are spawned only through `ProcessRunner` (enforced by ESLint).
- Analyzers report only facts they observed and state their verification level honestly. New analyzers implement `Analyzer` and are registered in `src/analyzers/index.ts`; add true-positive and trap cases to `test/unit/benchmark.test.ts`.
- Never fabricate evidence: `CommandEvidence` is created only from a real `RunResult`.
- User-facing strings go through `vscode.l10n.t` (runtime) or `package.nls.json` (manifest).

## Tests

| Command | Scope |
|---|---|
| `pnpm test` | Unit, end-to-end engine tests on real temporary Git repositories, labeled precision/recall corpus |
| `pnpm run test:integration` | Real VS Code Extension Development Host (set `VSCODE_EXECUTABLE` to use a local install) |
| `pnpm run perf` | Performance budgets on generated repositories |

Do not weaken a test to make it pass; fix the cause. A skipped test is not a pass.

## Commits

Conventional Commits (`feat(verification): …`). Do not push, publish or open releases without the maintainer's authorization.
