# Probato PR 1.0.1 — File-read resilience

## Incident

Electron attempts to mount a tracked fixture such as `extensions/css-language-features/server/test/pathCompletionFixtures/src/data/foo.asar` as an ASAR archive. The file may be intentionally malformed; even `fs.stat()` can throw `Error: Invalid package`. The failure occurred during review of `Drako01/armotusitio-ide` PR #81.

## Hotfix scope

| Scenario | Handling | Evidence |
| --- | --- | --- |
| Tracked ASAR / uppercase ASAR / ASAR path segment | Excluded from text analysis; raw OS filesystem hashes it for snapshot freshness (without Electron ASAR interception) | Unit regression |
| Untracked ASAR | Explicit skip; other files continue; content changes still invalidate repository snapshots | Unit regression |
| Git diff binary | Skip with reason, not silently treated as text | Unit regression |
| Non-text untracked (NUL / invalid UTF-8) | Explicit skip | Unit regression |
| Missing/renamed file during read | Return unavailable and rely on review snapshot integrity check | Unit regression |
| Oversized or growing file | Bound reads to a byte limit, reject unstable/oversized files | Unit regression for oversized |
| Symbolic link escape | Continue enforcing `resolveInside` containment | Existing boundary tests |
| Permission/IO errors on tracked files | Propagate to analyzer failure/limitation (no false pass) | Existing review engine behavior |
| Permission/temporary lock on untracked file | Explicit skipped-file reason | Source guard; Windows manual QA recommended |
| GitHub API-only PR review | Archive/binary excluded consistently by `applyLimits`; no local FS access | Existing PR flow |

## Validation before merge

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run test`
- [ ] `pnpm run build:prod`
- [ ] `pnpm run package`
- [ ] Windows VS Code/Electron: open `F:\\armotusitio-ide`, review GitHub PR #81 with an invalid `.asar` fixture; confirm that no `Invalid package` exception occurs
- [ ] Check displayed skipped-file limitations, analyzer status and that the revision reviewed matches the PR head

**Important:** No local runtime test has been executed by the GitHub connector during this change. CI and Windows Electron smoke remain mandatory before merge or release.
