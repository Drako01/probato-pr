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
7. Package: `pnpm run package` → `probato-pr.vsix`. Inspect with `unzip -l probato-pr.vsix`: only `dist/extension.js`, legal notices, media, l10n, manifests and user docs.
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

- **Manual:** `vsce publish --packagePath probato-pr.vsix`, authenticated interactively. Do not store Personal Access Tokens in files, scripts or repositories.
- **CI (preferred, to evaluate):** `@vscode/vsce` supports authenticating with Microsoft Entra ID credentials (`--azure-credential`), which allows a GitHub Actions OIDC federation to an Entra identity linked to the Marketplace publisher, without long-lived PATs. Confirm the current Microsoft documentation and set it up before adding a publish job (none is included; `docs/ci/ci.yml.example` only builds and tests).

## Rollback / withdrawal

- The Marketplace does not allow re-publishing an existing version. Fix forward with a patch version (`0.1.1`).
- For a severe issue: publish the previous good code as a new patch version, or unpublish the extension from the publisher management page (removes it for new installs; existing installs remain).
- Communicate in `CHANGELOG.md` and the Marketplace page.
