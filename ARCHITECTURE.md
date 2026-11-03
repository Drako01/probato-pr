# Probato PR architecture

## Governing principle

An observation is not proof. Probato keeps detection, executed verification and causal attribution separate.
Static analyzers and optional AI produce observations or hypotheses. Only actual process executions produce
command evidence, and only technically comparable base/head evidence can establish a regression.

## Layers

| Layer | Responsibility |
|---|---|
| `extension.ts`, `extension/` | VS Code composition, user approval, exact-state guards and commands. |
| `ui/`, `webview/` | Home, Summary, native trees, diagnostics and validated webview intentions. |
| `core/` | Pure review model, risk, labels, policies, explanations and observational comparison. |
| `analyzers/` | Deterministic detection, bounded AST and snapshot-only semantic analysis. |
| `git/` | Hardened Git reads, local actions, diffs and reviewed-content identity. |
| `github/` | Authenticated API access, PR delivery, conversations, checks and guarded merge. |
| `verification/` | Check discovery, approval binding, baselines, comparability and attribution. |
| `mutation/` | Optional installed Stryker adapter, independent states, normalization and differential gate. |
| `infrastructure/` | Process runner, worker RPC, revision indexes, bounded history and policy loading. |
| `reports/`, `cli.ts` | Markdown, JSON, SARIF and explicit command-line execution. |

Core and analysis layers do not depend on `vscode`. Repository text cannot define executable policy commands or
webview command IDs. The process runner is the sole subprocess boundary for verifiers; Git uses its hardened client.

## Review and analysis worker

The controller obtains the requested repository, checks trust and saves, acquires the session lock and records an
exact repository snapshot. Working, staged and historical reviews use content providers for the correct revision.
The lazy analysis worker runs the compiler and analyzers outside the extension host, receiving source through
bounded RPC. Cancellation terminates the worker; the next review creates a fresh one.

The engine isolates analyzer failures, surfaces coverage limitations, deduplicates findings and calculates risk.
The in-memory cache reuses results only when reviewed content and consumer/configuration snapshots agree.
Recorded durations are performance measurements, not evidence that code is correct.

## Semantic contracts

TypeScript Programs use a bounded in-memory host supplied by the review snapshot. Supported aliases, reexports
and workspace packages can establish static dependency relationships. No compiler plugins, network access,
external filesystem resolution or emit are required. Incomplete graphs fall back conservatively and disclose limits.
Static semantic relationships do not prove runtime behavior or causal regression.

## Verification and policies

Check discovery proposes tools already present in the project. Impact recommendations annotate the complete plan;
unknown relationships trigger a full-plan fallback. Only explicit approval, or a still-valid remembered approval,
can execute repository code. Approvals bind to content and executable definitions.

Baselines run failing checks in isolated worktrees. Dependency manifests, lockfiles and supported installed metadata
must support comparison before failures are attributed. Source links back into the head checkout are rejected.
Incompatible or incomplete environments produce inconclusive attribution, with reasons and preparation guidance.

`.probato.yml` is bounded, versioned and declarative. It can adjust supported severities, recommend detected check
IDs and configure the optional mutation gate. It cannot define executables, provide credentials, approve execution
or suppress findings. Critical and secret findings cannot be downgraded. Policy decisions survive risk recalculation
through explicit notes rather than stale prior verification limitations.

## Mutation testing

Mutation testing is a separate optional verifier, not another mandatory check kind. It invokes existing local
Stryker in isolated reviewed/base worktrees through the bounded runner. Its total time, concurrency, Node heap,
file and report limits are visible before approval. No Stryker installation occurs during normal product execution.

Execution status, verification outcome, baseline comparability, quality trend and gate decision remain independent.
Mutants retain their original Stryker status and normalized state. Comparable scores require equivalent source,
mutant population, dependencies, configuration and execution conditions. Only real run records become command
evidence. See [Mutation Testing](docs/MUTATION_TESTING.md) for score math, states and limits.

## Session, history and interface

The session is the single current-state source for Home, Summary, trees, diagnostics, status and reports.
Home and Summary are separate persistent webviews with nonce CSP, restricted resources, safe DOM text rendering
and allowlisted messages. Existing native surfaces remain available. New evidence and mutant detail is disclosed
progressively instead of replacing the primary workflow.

History stores bounded sanitized summaries and a limited set of validated full review snapshots. Legacy records
remain readable. Comparison requires the same known base, repository, branch, scope and target. It labels observations
as new, persisting or no longer observed; disappearance never implies resolution. Historical evidence cannot become
current execution approval.

## Delivery, export and localization

Local Git writes require previews and confirmation. GitHub writes validate target identity, reviewed head and
available protections; a merge request conditions the expected head and rechecks its destination. API atomicity
must not be overstated for the base branch.

JSON preserves structural identifiers and optional new fields. Markdown localizes explanatory text. SARIF keeps
machine states and mutation metadata without inventing confirmed source defects. English templates and Spanish
translations cover authored UI messages; rule IDs, paths, hashes, commands and external output remain unchanged.

## Extension points

New analyzers implement `Analyzer` and add real defect/trap cases. New tools extend discovery and diagnostic parsing.
Mutation adapters remain separate from the core state and gate evaluator. New AI providers remain text transports;
AI responses never create execution evidence. Existing report and historical contracts stay backward compatible
through optional fields and validated migrations.
