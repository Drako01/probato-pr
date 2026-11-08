# Detector benchmark — methodology

What is measured, how, and what the numbers do **not** mean. Results for a given commit are recorded in
[ENTERPRISE_AAAAA_TEST_EVIDENCE.md](ENTERPRISE_AAAAA_TEST_EVIDENCE.md).

## Scope

Only the deterministic analyzers registered in `src/analyzers/index.ts`. AI review is excluded on purpose: its
findings are hypotheses (`ai/review`, always `suspected`, never `confirmed`, never able to block a differential gate
alone — see `test/unit/ai-github-reports.test.ts` and `test/unit/quality-gate.test.ts`), so mixing them in would
contaminate the deterministic numbers. Prompt-injection resistance of the AI path is covered by
`ai-github-reports.test.ts` and `ai-byok.test.ts`, not by this benchmark.

## Corpus

| Corpus | Source | Status |
|---|---|---|
| `probato-authored` (version in `test/unit/benchmark/corpus.ts`) | Written by the project maintainers | Regression gate. **Not** an independent or external validation |
| External (real repositories, ≥600 cases, ≥20 projects) | — | **BLOCKED**: needs real-world changes under a compatible license and human ground-truth labels. No synthetic filler is used to reach the number |

Every case records: stable `id`, `language`, `tags` (rename, alias, barrel, pre-existing, placeholder,
consumer-updated, refactor, multi-file, deletion…), `provenance`, the base/head files, the untouched workspace files
and the expected rule IDs. A case with no expected rule is a **trap** and must name the rules it is designed to tempt
(`guards`). External cases use the same shape with `provenance: { source: 'external', repository, commit, license, path }`.

Known bias: the authored cases were written by people who know how the analyzers work. A 100% score on this corpus
shows that documented behavior does not regress; it says nothing about precision on real pull requests.

## Splits and leakage control

- The split is derived from `sha256(id)` (60% dev, 20% validation, 20% holdout), so no one chooses which cases are
  held out.
- The holdout is sealed: `HOLDOUT_SEAL` in `test/unit/benchmark.test.ts` is a SHA-256 over the canonical holdout
  cases. Editing a held-out case fails the test. A seal change requires a `CORPUS_VERSION` bump and a written reason;
  relabeling a case to make an analyzer pass is not an acceptable reason.
- For the authored corpus the holdout is still not blind (same authors). It becomes meaningful for external data.

## Metrics

Computed by `test/unit/benchmark/metrics.ts` (pure, unit-tested in `benchmark-harness.test.ts`):

- TP / FP / FN by rule ID per case; precision, recall and F1, overall, per split, per language and per rule.
- 95% **Wilson score intervals** with the sample size `n`. Precision or recall without a denominator is `n/a`, never 1.
- False positives per case, traps with any finding (`noisyTraps`).
- `inconclusive` rate: cases where an applicable analyzer failed, so a missing finding proves nothing.
- Per-rule coverage: every analyzer rule must have at least one positive and one negative case, or be listed in
  `KNOWN_GAPS`. The list is kept exact by a test, so a new rule cannot ship without cases unnoticed.

Rule IDs come from `test/unit/benchmark/rule-catalog.ts`, which is checked against the literals in
`src/analyzers/*.ts` and derives secret rules from `SECRET_PATTERNS`.

## Running

```bash
pnpm exec vitest run test/unit/benchmark.test.ts
# versioned JSON report (overall, bySplit, byLanguage, byRule)
PROBATO_BENCHMARK_REPORT=reports/benchmark.json pnpm exec vitest run test/unit/benchmark.test.ts
```

## Gate

On the authored corpus: every case exact, 0 noisy traps, 0 inconclusive, precision and recall ≥ 0.95. The
candidate AAAAA targets (precision ≥ 95%, recall ≥ 90% on a predefined holdout) apply **only to the external
benchmark** and are not claimed while it is BLOCKED.
