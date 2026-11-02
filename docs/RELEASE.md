# Release process

Publishing requires the maintainer's explicit authorization. Never publish, push tags or enable workflows without it.

## Versioning

SemVer. `0.x` while the public API (settings, commands, report schema) may still change. Report JSON carries `schemaVersion`; bump it on breaking report changes.

## Checklist

1. `CHANGELOG.md` updated; version bumped in `package.json`.
2. Clean install: `pnpm install --frozen-lockfile`.
3. Quality gate: `pnpm run verify` (typecheck, lint, unit + e2e engine tests, precision/recall corpus).
4. Integration: `pnpm run test:integration` (from a terminal **outside** VS Code, or unset `ELECTRON_RUN_AS_NODE`).
5. Performance: `pnpm run perf`; compare with the previous release.
6. Security: `pnpm audit --prod`; review `THIRD_PARTY_NOTICES.md` changes.
7. Package: `pnpm run package` → `probato-pr.vsix`. Inspect with `unzip -l probato-pr.vsix`: only `dist/extension.js`, `dist/webview/summary.js`, legal notices, media, l10n, manifests and user docs.
8. Clean install test:

   ```bash
   code --user-data-dir /tmp/p-ud --extensions-dir /tmp/p-ext --install-extension probato-pr.vsix
   code --user-data-dir /tmp/p-ud --extensions-dir /tmp/p-ext --list-extensions --show-versions
   ```

9. Packaged-content test: unzip the VSIX and run the integration suite with `PROBATO_EXTENSION_PATH=<unzipped>/extension`.
10. Smoke test by hand: open a real repository, run *Review Current Changes*, *Verify Findings*, export SARIF.
11. Update `PRODUCT_RELEASE_READINESS.md`; release only on **GO**.
12. Record the VSIX SHA-256 in the release notes.

## Publishing (after authorization)

Step-by-step guide, accounts and first-time setup: [`PUBLICACION.md`](PUBLICACION.md) (Spanish).

- **First release:** upload the verified `probato-pr.vsix` on the publisher management page (no token needed).
- **Later releases (automatic):** `.github/workflows/publish.yml`. A pull request merged to `main` that changes the version in `package.json` runs the quality gate, packages the VSIX once, publishes that same file to the Marketplace (Trusted Publishing, `vsce publish --oidc`, no stored token) and to Open VSX, and creates the GitHub release with the VSIX and its SHA-256. A merge that keeps the version only verifies. *Actions → publish → Run workflow* publishes the version on `main` by hand; publishing is idempotent (`--skip-duplicate`).
- **Credentials:** the `marketplace` and `open-vsx` GitHub environments are limited to `main`. The Marketplace needs a Trusted Publishing policy (owner `Drako01`, repository `probato-pr`, workflow `publish.yml`, environment `marketplace`). Open VSX uses the `OVSX_PAT` secret of the `open-vsx` environment; rotate it in open-vsx.org → Settings → Access Tokens and `gh secret set OVSX_PAT --env open-vsx`.
- **Do not use Personal Access Tokens for the Marketplace:** global Azure DevOps PATs are retired on 2026-12-01.
- **Workflow changes** need a pull request approved by the code owner; pin every third-party action to a full commit SHA (Dependabot keeps them current).

## Rollback / withdrawal

- The Marketplace does not allow re-publishing an existing version. Fix forward with a patch version (`0.1.1`).
- For a severe issue: publish the previous good code as a new patch version, or **Unpublish** the extension from the publisher management page (no new downloads; statistics kept; can be published again). Never use **Remove**: it is irreversible and the name stays reserved forever.
- Communicate in `CHANGELOG.md` and the Marketplace page.
