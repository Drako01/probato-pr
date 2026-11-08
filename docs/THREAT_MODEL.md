# Threat model

Scope: the Probato PR VS Code extension and its CLI (`probato-pr`), version 0.7.0 candidate. Reviewed 2026-11-08.
This page lists what an attacker can control, what they could gain, the control that stops it and the test that
proves the control. It does not claim absolute security or any external certification. The short user-facing summary
lives in [SECURITY.md](../SECURITY.md).

## Assets

- The developer's machine and user account (code execution, files outside the repository).
- Credentials: GitHub session (`repo` scope), AI provider keys (VS Code SecretStorage), Marketplace/Open VSX
  publishing identity (CI only, OIDC).
- Repository content sent to an AI provider the user chose.
- Integrity of review results: a finding must never look more certain than its evidence.

## Attackers and entry points

| Attacker | Controls |
|---|---|
| Author of an untrusted repository or pull request | Files, diffs, paths, symlinks, `.git/config` (when cloned with it), `package.json` scripts and hooks, `.probato-pr.json` policy, commit messages, PR title/body |
| Malicious or compromised AI endpoint | Every byte of the model response, HTTP status and headers (including redirects) |
| Network attacker | Traffic that is not TLS-protected |
| Compromised dependency or CI action | Build output and published artifacts |

## Threats, controls and evidence

| # | Threat | Control | Evidence (tests) | Residual risk |
|---|---|---|---|---|
| T1 | Git ref injection (`--output=…`, ranges, shell characters) | `assertSafeRef` allowlist before every Git call | `resilience.test.ts`, `property-based.test.ts` (refs) | — |
| T2 | Git config executing code during reads (`core.fsmonitor`, external diff, textconv, pager) | Every call forces `core.fsmonitor=false`, `diff.external=`, `--no-ext-diff`, `--no-textconv`, `core.pager=cat` | `verification-e2e.test.ts` (malicious fsmonitor not executed) | Git itself and its built-in behaviour are trusted |
| T3 | Clean/smudge filters and hooks while materializing a baseline | Hooks path pointed at an empty folder; configured `filter.*` drivers refused | `repository-snapshot.test.ts` | — |
| T4 | Command injection through Windows `.cmd` shims | Argument arrays with `shell: false`; shims go through `cmd.exe /d /c` only when every argument matches `[\w:./=@+-]` | `process-runner.test.ts`, `adversarial.test.ts` (`>`, `<`, `()`, `!VAR!`, CR/LF, quotes, empty) | — |
| T5 | Running repository code without consent | Checks that execute repository code are never pre-selected; modal confirmation lists exact executable and arguments; remembered approvals are bound to a SHA-256 of command, directory and script body | `approved-checks.test.ts`, `audit-hardening.test.ts` (lifecycle hooks and entrypoints void approval) | **No sandbox**: approved checks run with the user's permissions (see T13) |
| T6 | Path traversal from diffs, PR file lists or AI output | `resolveInside`: refuses absolute, drive and UNC paths, NUL, `..`, and symlinks leaving the root — including symlinked parents of paths that do not exist yet | `core-utils.test.ts`, `adversarial.test.ts` | — |
| T7 | TOCTOU between path check and use | Every use calls `resolveInside` again (no cached decision) | `adversarial.test.ts` (directory swapped for a junction/symlink) | A swap in the microseconds between the check and the read is not prevented; reads of repository files are the only consumers |
| T8 | Secret leakage into evidence, reports, SARIF, history or AI context | One secret catalog redacts every sink; sensitive files are never sent to AI | `audit-hardening.test.ts`, `sarif-schema.test.ts`, `ai-github-reports.test.ts`, `property-based.test.ts` (redaction) | Unknown secret formats are not recognised (`KNOWN_GAPS` in the benchmark) |
| T9 | AI key exfiltration through configuration | Keys stored per origin; base URL is application-scoped (a repository cannot change it), HTTPS unless loopback, no credentials/query/fragment | `ai-byok.test.ts`, `adversarial.test.ts` (metadata IP, loopback look-alikes, `javascript:`, `file:`) | The user can still point the provider at any HTTPS host they choose |
| T10 | Exfiltration through an AI endpoint redirect (307/308 resend the body, possibly to plain http) | Redirects are never followed (`redirect: 'manual'`, any 3xx is an error) | `adversarial.test.ts` (attacker server receives nothing) | — |
| T11 | Prompt injection raising certainty or executing actions | Repository data fenced, fences cannot be closed from inside; JSON schema on output; findings only on added lines; AI findings are never `confirmed`; nothing in a response is executed | `ai-github-reports.test.ts`, `property-based.test.ts` (AI parsing), `review-proof.test.ts` | A model can still produce a misleading *hypothesis*; it is labelled as such |
| T12 | XSS / message abuse in the Review Summary webview | CSP `default-src 'none'` with nonce; text rendered with `textContent`; every message schema-validated against an allowlist of Probato PR commands; unknown fields dropped | `summary-ui.test.ts`, `adversarial.test.ts` (foreign commands, oversized IDs, unknown types) | — |
| T13 | Approved check escaping the repository (malware in a test script) | Out of scope of the current runner: worktree isolation is **not** a sandbox | Documented in SECURITY.md | **Accepted**: users must review scripts before approving. An optional container backend is not implemented (checklist IV.3) |
| T14 | GitHub write on the wrong commit or PR | Every write is bound to the reviewed head SHA; merge re-checks head and base; redirects of authenticated requests refused | `github-delivery.test.ts` | — |
| T15 | Token leakage through Actions log redirect | The one allowed redirect (signed log storage) is followed without the GitHub token | `github-delivery.test.ts` | — |
| T16 | Resource exhaustion (huge diffs, runaway checks) | Analysis worker heap limit and deadline; process tree killed on cancel/timeout; bounded logs | `analyzer-worker.test.ts`, `process-runner.test.ts`, `github-delivery.test.ts` | Checks the user approved can still consume CPU until their timeout |
| T17 | Supply chain: tampered or unattributable VSIX | Lockfile frozen; actions pinned by SHA; one VSIX with SHA-256 re-checked by every consumer; signed build provenance attestation; CycloneDX SBOM attached to the release | `workflow-contract.test.ts` | Not exercised live until the next publishing run; development-only advisory `minimatch` triaged as WARN (checklist IV.4) |
| T18 | Untrusted workspace | `untrustedWorkspaces: limited`; commands refuse Git and tools until trusted | Manifest + command guards | — |

## Out of scope

Compromise of VS Code, Node.js, Git, the operating system or the user's account; a malicious extension running in the
same Extension Host; physical access.
