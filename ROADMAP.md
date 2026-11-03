# Roadmap

Priorities follow the product principle: precision and proof over volume.

## Delivered before 0.5

Local and PR review, exact-state verification, GitHub delivery, CLI, monorepo discovery, external SARIF,
conservative cross-stack checks, incremental analysis and the Home control center are implemented.

## 0.5 — Proof-driven upgrade

- Explain each finding through explicit evidence and missing-proof notes.
- Compare compatible reviews without treating disappearance as resolution.
- Resolve supported TypeScript aliases and reexports through bounded snapshot-only semantics.
- Run analyzers in a lazy cancellable worker and expose measured analysis time.
- Recommend existing checks by impact and disclose baseline dependency comparability.
- Apply versioned declarative repository policy without granting execution permission.
- Integrate optional local Stryker mutation testing with independent states and a differential quality gate.
- Publish and synchronize Open VSX through one OIDC Trusted Publisher workflow.

Implementation and release acceptance are separate. See [release readiness](PRODUCT_RELEASE_READINESS.md) for
current verification, including real mutation execution rather than mocks alone.

## Next priorities

- Expand an independently sourced, anonymized defect corpus while retaining authored false-positive traps.
- Extend supported dependency environments and semantic package conditions conservatively.
- Validate remote-development environments and accessibility with native assistive technology.
- Add mutation tool adapters only when their evidence and comparability can be defined honestly.
- Improve integration-test impact mapping without presenting selective execution as full-system assurance.

## Deliberate boundaries

Core review remains useful offline without accounts, AI or mutation tools. New features must preserve explicit
approval and explain incomplete coverage. More hosting providers, language parsers or telemetry are not substitutes
for stronger evidence. Web-only verification remains outside the local process execution contract.
