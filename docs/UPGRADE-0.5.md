# Proof-driven review

Probato separates observations, executed evidence and attribution. The 0.5 features extend those boundaries;
they do not let AI text, a passing unrelated check or a matching source line confirm a defect.

## Explain findings

Open a finding in Results to inspect its observation, explicit evidence references, linked checks and missing
proof. Unavailable evidence is disclosed. A source relationship established by TypeScript remains static evidence;
only a comparable executed diagnostic can establish a confirmed regression.

## Compare reviews

History retains a bounded set of full snapshots alongside summary entries. Older storage remains readable.
Comparison requires a known identical base commit, repository, branch, revision target and scope. A snapshot
that was not retained cannot be compared. Historical evidence is never restored as current approval.

The labels are observational: newly observed, still observed and no longer observed. A formerly failing check
that now passes is shown separately; it does not prove that every associated finding was resolved. Identity
matching handles unchanged stable IDs and consumes duplicate observations conservatively.

## Repository policy

A bounded `.probato.yml` supports version 1 only. For staged and historical reviews, the policy is read from the
reviewed snapshot. Invalid policy is ignored with a visible warning. Policies cannot add commands, credentials,
network requests, approvals or finding suppressions. Critical findings and secret findings cannot be downgraded.

```yaml
version: 1
review:
  severityOverrides:
    contracts/export-removed: high
checks:
  recommendations:
    - paths: ["apps/web/**"]
      checkIds: ["apps/web:script:typecheck"]
mutation:
  enabled: true
  failOnDegradation: true
  minimumScore: 75
  tolerancePoints: 0
```

Only detected check IDs may be recommended. Unknown mappings trigger a full-plan fallback; all checks remain
available. Mutation policy enables a gate, not mutation execution. Explicit user or CLI authorization is still
required. Every severity adjustment is disclosed in the report.

## Baseline reproducibility

Probato compares dependency inputs and supported installed metadata before attributing ordinary check failures.
Missing or mismatched metadata produces an inconclusive baseline with guidance. The user can prepare separate
revision environments using their lockfiles; Probato does not install dependencies automatically.

Matching metadata does not attest to external services or every toolchain condition. Workspace links into head
source remain rejected. [Mutation testing](MUTATION_TESTING.md) records additional runtime and scope fingerprints.

## Performance and coverage limits

The compiler runs in a lazy worker, with progress, cancellation and bounded content transfer. A cancelled worker
is terminated and the next review starts a fresh one. Analysis durations are measurements, not proof of correctness.
The in-memory cache reuses only matching reviewed content and consumer/configuration snapshots.

Semantic resolution is bounded and does not load files outside the supplied snapshot or execute plugins.
Unsupported package conditions, ambiguous packages, unreadable sources or unresolved inheritance produce
limitations and conservative fallback. The authored benchmark corpus is a regression suite, not an independent
comparison against other products.

## CLI

```bash
probato-pr --format json --output current.json
probato-pr --compare previous.json --format markdown --locale es
probato-pr --list-checks
```

Comparison accepts a bounded validated prior Probato JSON report and does not restore its evidence as current.
Check listing includes impact recommendations. Mutation execution has separate explicit flags documented in the
[mutation guide](MUTATION_TESTING.md).
