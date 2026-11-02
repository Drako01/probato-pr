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
- User-facing strings go through `vscode.l10n.t` (UI layer), `tr()` / `msg()` from `src/core/i18n.ts` (engine layers, which cannot import `vscode`) or `package.nls.json` (manifest). Write message templates as single-quoted literals with `{0}` placeholders, and check the Spanish bundle with `node scripts/l10n-keys.mjs l10n/bundle.l10n.es.json`.

## Tests

| Command | Scope |
|---|---|
| `pnpm test` | Unit, end-to-end engine tests on real temporary Git repositories, labeled precision/recall corpus |
| `pnpm run test:integration` | Real VS Code Extension Development Host (set `VSCODE_EXECUTABLE` to use a local install) |
| `pnpm run perf` | Performance budgets on generated repositories |

Do not weaken a test to make it pass; fix the cause. A skipped test is not a pass.

## How to contribute

`main` is protected: nobody pushes to it directly, history cannot be rewritten, and every change arrives through a pull request.

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Fork the repository and create a branch from `main` (`feat/short-description`, `fix/short-description`).
3. Make the change with its tests, and run `pnpm run verify`.
4. Open a pull request against `main` and fill in the template. The maintainer (`CODEOWNERS`) must approve it, and every review conversation must be resolved.
5. Pull requests are **squash-merged**, so the PR title becomes the commit message: write it as a Conventional Commit.

Release tags (`v*`) can only be created by the maintainer; publishing to the Marketplace follows `docs/RELEASE.md`.

## Commits

Conventional Commits (`feat(verification): …`, `fix(ai): …`, `docs: …`).
