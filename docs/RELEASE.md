# Release process

Publishing requires the maintainer's explicit authorization. Never publish, push tags or enable workflows without it.

## Versioning

SemVer. `0.x` while the public API (settings, commands, report schema) may still change. Report JSON carries
`schemaVersion`; bump it on breaking report changes.

## Checklist

1. `CHANGELOG.md` updated; version bumped in `package.json`.
2. Clean install: `pnpm install --frozen-lockfile`.
3. Quality gate: `pnpm run verify` (typecheck, lint, unit + e2e engine tests, precision/recall corpus).
4. Integration: `pnpm run test:integration` (from a terminal **outside** VS Code, or unset `ELECTRON_RUN_AS_NODE`).
5. Performance: `pnpm run perf`; compare with the previous release.
6. Security: `pnpm audit --prod`; review `THIRD_PARTY_NOTICES.md` changes.
7. Package: `pnpm run package` → `probato-pr.vsix`. Inspect with `unzip -l probato-pr.vsix`: only extension/CLI
   bundles, `dist/analyzer-worker.js`, the Summary webview, legal notices, media, l10n, manifests and user docs.
8. Clean install test:

   ```bash
   code --user-data-dir /tmp/p-ud --extensions-dir /tmp/p-ext --install-extension probato-pr.vsix
   code --user-data-dir /tmp/p-ud --extensions-dir /tmp/p-ext --list-extensions --show-versions
   ```

9. Packaged-content test: unzip the VSIX and run the integration suite with
   `PROBATO_EXTENSION_PATH=<unzipped>/extension`.
10. Smoke test by hand: open a real repository, run *Review Current Changes*, *Verify Findings*, export SARIF.
11. Update `PRODUCT_RELEASE_READINESS.md`; release only on **GO**.
12. Record the VSIX SHA-256 in the release notes.

## Publishing (after authorization)

Step-by-step guide, accounts and first-time setup: [`PUBLICACION.md`](PUBLICACION.md) (Spanish).

- **First release:** upload the verified `probato-pr.vsix` on the publisher management page (no token needed).
- **Validation before merge:** `.github/workflows/ci.yml` runs on every pull request (and `merge_group`, should a
  merge queue be enabled). Its `Verify (ubuntu-latest|windows-latest|macos-latest)` jobs are the required checks of
  the `main` ruleset; the Extension Host integration test and `pnpm audit --prod` run on Linux. `Mutation E2E` runs a
  real Stryker fixture only when `src/mutation/**`, `src/verification/**`, `src/reports/**`, the fixture or the
  dependencies change; otherwise it reports *skipped*.
- **Later releases (automatic):** `.github/workflows/publish.yml`, on `push` to `main` only. A push that keeps the
  version does nothing beyond the plan job (no repeated QA). A push that changes the version in `package.json`
  (compared with the previous tip of `main`, so squash merges and multi-commit pushes are both covered) runs
  `pnpm audit --prod`, packages the VSIX once, checks that its manifest version matches, records its SHA-256, creates
  a signed build provenance attestation (`actions/attest-build-provenance`, verifiable with
  `gh attestation verify probato-pr.vsix --repo Drako01/probato-pr`) and a CycloneDX SBOM of the runtime
  dependencies (`pnpm run sbom`), and publishes that same file to the Marketplace (Trusted Publishing,
  `vsce publish --oidc`, no stored token) and to Open VSX, and creates the GitHub release with the VSIX, its SHA-256
  and the SBOM. Every publishing job re-checks the SHA-256 before using the file.
  *Actions → publish → Run workflow* publishes the version on `main` by hand; publishing is idempotent
  (`--skip-duplicate`) and runs are never cancelled half-way.
- **When the release gate runs after merge:** the `main` ruleset has `strict_required_status_checks_policy=true`
  (branches must be up to date), so a squash merge of a green PR yields the tree its checks validated. The plan job
  proves it for each publishing push: it finds the merged PR of the pushed commit, compares its head tree with the
  pushed tree and requires the three `Verify (…)` checks to have succeeded on that head. Only when any of that cannot
  be shown (a push that did not come from a PR, an admin bypass, a different tree) does the release gate
  (`verify:delivery` + Extension Host on Linux) run on the merged tree. The checksum proves integrity between jobs;
  the attestation proves which workflow run and commit built the file.
- **Open VSX never blocks the release.** The Marketplace is the primary channel and the GitHub release depends on it
  only. `scripts/open-vsx-publish.mjs` retries transient failures, waits for the version to become active and, if the
  registry holds it back (unverified namespace, publish-time scan), reports a warning instead of failing. The
  scheduled sync job in the same `publish.yml` runs daily: it republishes the latest release if it is not active,
  closes its tracking issue when it is, and opens one if it is still not active after three days. After publishing,
  the Marketplace job waits up to 15 minutes for the version to be visible and fails if it is not.
- **Credentials:** the `marketplace` and `open-vsx` GitHub environments are limited to `main`. The Marketplace needs a
  Trusted Publishing policy (owner `Drako01`, repository `probato-pr`, workflow `publish.yml`, environment
  `marketplace`). Open VSX uses a single Trusted Publisher for owner `Drako01`, repository `probato-pr`, workflow
  `publish.yml`, environment `open-vsx`. Release publication and scheduled synchronization share that workflow. Both
  jobs request OIDC and the trusted-publishing subprocess removes PAT precedence; no Open VSX PAT is passed from CI.
- **Do not use Personal Access Tokens for the Marketplace:** global Azure DevOps PATs are retired on 2026-12-01.
- **Workflow changes** need a pull request approved by the code owner; pin every third-party action to a full commit
  SHA (Dependabot keeps them current).

## Optional mutation acceptance

Run the opt-in real Stryker fixture described in [Mutation Testing](MUTATION_TESTING.md) when mutation execution
or comparability changes. Record base/head commits, tool and dependency versions, mutant population and exported
reports. Ordinary checks must continue without Stryker installed. A fixture skipped for a missing tool is not E2E
acceptance. Preserve all existing README screenshots when updating release documentation.

## Rollback / withdrawal

- The Marketplace does not allow re-publishing an existing version. Fix forward with a patch version (`0.1.1`).
- For a severe issue: publish the previous good code as a new patch version, or **Unpublish** the extension from the
  publisher management page (no new downloads; statistics kept; can be published again). Never use **Remove**: it is
  irreversible and the name stays reserved forever.
- Communicate in `CHANGELOG.md` and the Marketplace page.
