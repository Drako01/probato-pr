// Labeled corpus of controlled defects and deliberate false-positive traps for the deterministic analyzers.
// The corpus is authored by the project: it is a regression gate, not a comparable or external benchmark.
// Set PROBATO_BENCHMARK_REPORT=<file> to write the versioned JSON report (overall, split, language, rule).
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultAnalyzers } from '../../src/analyzers';
import { ReviewEngine } from '../../src/core/review-engine';
import { CASES, CORPUS_ID, CORPUS_VERSION, holdoutSeal, KNOWN_GAPS, splitOf } from './benchmark/corpus';
import { buildReport, formatTally, type CaseOutcome } from './benchmark/metrics';
import { ANALYZER_RULES } from './benchmark/rule-catalog';
import { changeSetOf, workspaceOf } from './helpers';

/**
 * Changing a holdout case changes this value. Update it only together with a CORPUS_VERSION bump and a note in
 * docs/BENCHMARK.md explaining why a held-out label changed; never to make the analyzers pass.
 */
const HOLDOUT_SEAL = '33c922d8a367e40b7607ab6cd308b53de7e1cbce903f85bfc051fda2778811e9';

async function runCorpus(): Promise<CaseOutcome[]> {
  const engine = new ReviewEngine(createDefaultAnalyzers(), 'bench');
  const outcomes: CaseOutcome[] = [];
  for (const c of CASES) {
    const heads = Object.fromEntries(c.files.filter((f) => f.head !== undefined).map((f) => [f.path, f.head ?? '']));
    const review = await engine.review(changeSetOf(c.files), workspaceOf({ ...(c.workspace ?? {}), ...heads }));
    outcomes.push({
      id: c.id,
      language: c.language,
      split: splitOf(c.id),
      expected: [...c.expected],
      reported: [...new Set(review.findings.map((f) => f.ruleId))].sort(),
      inconclusive: review.analyzerRuns.some((run) => run.status === 'failed'),
    });
  }
  return outcomes;
}

describe('labeled corpus: integrity', () => {
  it('has unique IDs, known rule IDs and every split populated', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    const known = new Set(ANALYZER_RULES);
    for (const c of CASES) {
      for (const rule of [...c.expected, ...(c.guards ?? [])]) expect(known.has(rule), `${c.id}: ${rule}`).toBe(true);
      expect(c.expected.length === 0 ? (c.guards?.length ?? 0) > 0 : c.guards === undefined, `${c.id}: traps name their guarded rules, positives do not`).toBe(true);
    }
    expect(new Set(CASES.map((c) => splitOf(c.id)))).toEqual(new Set(['dev', 'validation', 'holdout']));
  });

  it('keeps the holdout sealed', () => {
    expect(holdoutSeal(CASES)).toBe(HOLDOUT_SEAL);
  });

  it('lists exactly the rules that lack a positive or a negative case', () => {
    const gaps: Record<string, string> = {};
    for (const rule of ANALYZER_RULES) {
      const positive = CASES.some((c) => c.expected.includes(rule));
      const negative = CASES.some((c) => c.guards?.includes(rule) === true);
      if (!positive || !negative) gaps[rule] = !positive && !negative ? 'no-cases' : positive ? 'no-negative' : 'no-positive';
    }
    expect(gaps).toEqual(KNOWN_GAPS);
  });
});

describe('labeled corpus: precision / recall / false-positive rate', () => {
  it('meets the regression gate and reports per split, language and rule', async () => {
    const outcomes = await runCorpus();
    const report = buildReport({ id: `${CORPUS_ID}@${CORPUS_VERSION}`, provenance: 'authored by the project; not external validation', holdoutSeal: HOLDOUT_SEAL }, outcomes, ANALYZER_RULES);
    console.log(formatTally('[benchmark] overall', report.overall));
    for (const [split, t] of Object.entries(report.bySplit)) console.log(formatTally(`[benchmark] split=${split}`, t));
    for (const [language, t] of Object.entries(report.byLanguage)) console.log(formatTally(`[benchmark] language=${language}`, t));
    const target = process.env.PROBATO_BENCHMARK_REPORT;
    if (target) {
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    }

    const mismatches = outcomes
      .filter((o) => o.expected.join() !== o.reported.join())
      .map((o) => `${o.id}: expected [${o.expected.join(', ')}], got [${o.reported.join(', ')}]`);
    expect(mismatches).toEqual([]);
    expect(report.overall.inconclusiveRate).toBe(0);
    expect(report.overall.noisyTraps).toBe(0);
    expect(report.overall.precision?.value).toBeGreaterThanOrEqual(0.95);
    expect(report.overall.recall?.value).toBeGreaterThanOrEqual(0.95);
  });
});
