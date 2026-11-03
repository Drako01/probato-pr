# Mutation testing and differential quality gates

Mutation testing is optional. Probato uses an existing local Stryker installation; it does not implement a
mutation engine, install project dependencies or make mutation testing mandatory for reviews or pull requests.
The initial integration targets JavaScript and TypeScript projects with `stryker.config.json`.

## Run from the editor

1. Review the current changes or the committed revision first.
2. Open Mutation Testing from Home or Results.
3. Inspect the impacted files, revision commits, limits and separate gate policy.
4. Explicitly approve the reviewed revision only, or the reviewed revision and its base.

Ordinary Verify does not run mutation testing. A repository policy or an enabled gate is not execution approval.
Missing Stryker or unsupported configuration produces a justified `SKIP`; missing comparable measurements produce
`INCONCLUSIVE`. Neither is a successful verification.

## Scope and reproducibility

The authorized scope consists of changed source files and supported direct source imports of changed tests.
Probato does not expand an unresolved impact into the entire repository. A structured report containing files
outside the authorized scope is rejected. Source and tests are executed in isolated worktrees, preserving the
reviewed changes while keeping the user's checkout untouched by the integration itself.

Each real run records its commit, source and dependency fingerprints, configuration and execution-condition
fingerprints, Node and Stryker versions, available dependency versions, timestamps, command, output hash and report
hash. Tests may intentionally differ between revisions: their purpose is to measure a changed test suite against
an equivalent source and mutant population. Their identities are recorded separately.

A quantified differential requires equivalent mutated source, population, report schema, dependencies, runner,
configuration, runtime and resource conditions. If these cannot be established, the comparison is inconclusive
and no demonstrated score delta is emitted. A source change that alters the mutation population cannot be treated
as an equivalent aggregate simply because both runs produced percentages.

## Four independent dimensions

| Dimension | Values | Meaning |
|---|---|---|
| Execution | `NOT_REQUESTED`, `AWAITING_APPROVAL`, `QUEUED`, `RUNNING`, `COMPLETED`, `CANCELLED` | What the execution did. |
| Verification | `PASS`, `FAIL`, `WARN`, `SKIP`, `ERROR`, `INCONCLUSIVE` | What the evidence establishes. |
| Quality trend | `IMPROVED`, `UNCHANGED`, `DEGRADED`, `INCONCLUSIVE`, `NOT_APPLICABLE` | Evolution against a comparable base. |
| Gate decision | `PASS`, `FAIL`, `WARN`, `SKIP`, `INCONCLUSIVE` | Whether the configured gate accepts the result. |

Execution transitions follow `NOT_REQUESTED → AWAITING_APPROVAL → QUEUED → RUNNING → COMPLETED`.
Pending and running executions may transition to `CANCELLED`. Arbitrary transitions are rejected. Terminal results
retain their cause, timestamps and available evidence. A completed process does not imply verification `PASS`.

Baseline status is separately `COMPARABLE`, `NOT_COMPARABLE` or `MISSING`, with reasons. Infrastructure failures
are `ERROR` or `INCONCLUSIVE`, never confirmed regressions. Cancellation cannot yield a successful gate.

## Scores and individual mutants

Probato preserves the Stryker status alongside its normalized status.

| Stryker status | Normalized status | Treatment |
|---|---|---|
| `Killed` | `KILLED` | Detected mutant; counts in both score numerators. |
| `Survived` | `SURVIVED` | Undetected mutant; not a confirmed application defect. |
| `NoCoverage` | `NO_COVERAGE` | Undetected due to missing coverage; not an execution error. |
| `Timeout` | `TIMED_OUT` | Counts as detected in Stryker's score; excluded from the killed-only numerator. |
| `CompileError` | `COMPILE_ERROR` | Not a killed mutant; incomplete evidence prevents a differential conclusion. |
| `RuntimeError` | `RUNTIME_ERROR` | Not a killed mutant; execution problems are disclosed. |
| `Ignored` | `IGNORED` | Excluded from the evaluated score population. |
| `Pending` or an unknown status | `NOT_RUN` | Unevaluated; no successful differential conclusion. |

The Stryker Mutation Score is `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage) × 100`.
The separate killed-only ratio is `Killed / (Killed + Timeout + Survived + NoCoverage) × 100`.
These are different metrics. Coverage percentage is another metric and is not substituted for either score.
A timeout or incomplete run prevents a demonstrated aggregate differential even when a tool score is available.
See the official [mutant states and
metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).

Mutant identities use source context and mutation semantics rather than only report IDs or line numbers.
Attribution is `INTRODUCED`, `PRE_EXISTING`, `RESOLVED`, `PERSISTENT` or `UNKNOWN`. A mutant killed on the base but
surviving now can establish introduced test degradation when comparison is valid. A survivor already present on
the base is not a new regression. Resolution requires the same previously undetected mutant to be killed now;
disappearance from a diff alone never resolves it.

## Differential gate policy

```yaml
version: 1
mutation:
  enabled: true
  failOnDegradation: true
  minimumScore: 75
  tolerancePoints: 0
```

If the comparable baseline is 85% and the current score is 78%, the variation is **−7 percentage points** and the
trend is `DEGRADED`. With the policy above, the gate is `FAIL`, even though both scores exceed 75%.
The gate remains separate from ordinary checks and does not change their thresholds or Stryker's original
configured thresholds. Zero minimum score disables Probato's absolute score threshold, not its differential check.

## Limits and security boundary

Defaults are a total 600-second budget, one Stryker worker, 1024 MB Node heap per process and at most 30 impacted
files. Limits can be configured before approval. Concurrency is capped at eight and structured reports are bounded.
The time budget is shared by preparation and both revisions. Copy loops and process launches check cancellation
and the deadline. An already-running Git setup operation has its own bounded timeout and may finish before a
cancellation is observed; this is not a hard real-time or operating-system quota.

The integration is not a sandbox. Project tests and installed tool plugins execute with the user's permissions.
The Node heap setting is a per-process heap budget, not an operating-system memory cap. Stryker must be installed
in the project's existing environment. Probato never silently broadens scope or installs dependencies.

## CLI and reports

```bash
probato-pr --mutation --mutation-baseline --mutation-gate --mutation-fail-on-degradation --format json
probato-pr --mutation --mutation-timeout 300 --mutation-concurrency 1 --mutation-memory 1024 --locale es
```

The explicit `--mutation` flag authorizes execution; `--mutation-baseline` separately authorizes the base run.
JSON preserves structured states, mutants and provenance. Markdown presents the four dimensions, reasons, scores
and bounded mutant details. SARIF retains mutation results in run properties without turning survivors into
confirmed source-code findings. Existing command-evidence navigation uses real process records only.

## Validation and reproducible E2E

Unit acceptance covers 85% → 78% as −7 points, allowed/rejected transitions, non-comparable populations,
pre-existing mutants and independent gate decisions. Execution acceptance must additionally cover timeout,
cancellation, tool errors and missing Stryker.

A real TypeScript fixture has already executed Stryker 10.1.1 with both killed and surviving mutants. The initial
run measured 5 killed / 2 survived on the base and 3 killed / 4 survived after weakening tests: 71.43% → 42.86%,
with the same seven-mutant population. That is execution evidence, not a mock. The final hardened fixture rerun
passed, including terminal-state emission and actual Markdown, JSON and SARIF
export assertions. The current release-readiness record tracks remaining integrated release validation.

Run the prepared fixture without reinstalling its tools:

```powershell
$env:PROBATO_MUTATION_E2E = '1'
$env:PROBATO_MUTATION_FIXTURE_ROOT = '<prepared temporary fixture path>'
pnpm run test:mutation:e2e
```

For a fresh temporary fixture, set `PROBATO_MUTATION_E2E_INSTALL=1` only after explicitly approving that test-only
installation. The runner records the resulting artifact path and does not add dependencies to Probato.

The opt-in E2E runner uses a temporary fixture with an explicitly prepared Stryker installation. It does not add
Stryker to Probato's mandatory dependencies or to a user's project. Ordinary verification must continue to pass
without Stryker installed. See [release readiness](../PRODUCT_RELEASE_READINESS.md) for the final run evidence and
remaining limitations. Tool configuration options are described in the official
[Stryker configuration guide](https://stryker-mutator.io/docs/stryker-js/configuration/).
