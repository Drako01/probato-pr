import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, tally, wilson, type CaseOutcome } from './benchmark/metrics';
import { ANALYZER_RULES } from './benchmark/rule-catalog';

const outcome = (id: string, expected: string[], reported: string[], extra: Partial<CaseOutcome> = {}): CaseOutcome =>
  ({ id, language: 'typescript', split: 'dev', expected, reported, inconclusive: false, ...extra });

describe('benchmark metrics', () => {
  it('computes Wilson 95% intervals and refuses an empty sample', () => {
    expect(wilson(0, 0)).toBeUndefined();
    const half = wilson(5, 10);
    expect(half?.low).toBeCloseTo(0.2366, 4);
    expect(half?.high).toBeCloseTo(0.7634, 4);
    const perfect = wilson(10, 10);
    expect(perfect?.value).toBe(1);
    expect(perfect?.low).toBeCloseTo(0.7225, 4);
    expect(perfect?.high).toBe(1);
  });

  it('counts TP/FP/FN, noisy traps and inconclusive cases, overall and per rule', () => {
    const outcomes = [
      outcome('hit', ['a/x'], ['a/x']),
      outcome('miss', ['a/x'], []),
      outcome('extra', ['a/x'], ['a/x', 'b/y']),
      outcome('noisy-trap', [], ['b/y'], { inconclusive: true }),
      outcome('clean-trap', [], []),
    ];
    const all = tally(outcomes);
    expect(all).toMatchObject({ cases: 5, traps: 2, tp: 2, fp: 2, fn: 1, noisyTraps: 1, inconclusiveRate: 0.2, falsePositivesPerCase: 0.4 });
    expect(all.precision?.value).toBe(0.5);
    expect(all.recall?.value).toBeCloseTo(2 / 3);
    expect(all.f1).toBeCloseTo(4 / 7);
    expect(tally(outcomes, 'a/x')).toMatchObject({ tp: 2, fp: 0, fn: 1 });
    expect(tally(outcomes, 'b/y')).toMatchObject({ tp: 0, fp: 2, fn: 0, recall: undefined });
    expect(tally(outcomes, 'b/y').precision?.value).toBe(0);
  });

  it('never reports precision or recall without a denominator', () => {
    const t = tally([outcome('trap', [], [])]);
    expect(t.precision).toBeUndefined();
    expect(t.recall).toBeUndefined();
    expect(t.f1).toBeUndefined();
  });

  it('groups by split and language in a versioned report', () => {
    const report = buildReport({ id: 'c@1', provenance: 'p', holdoutSeal: 's' }, [outcome('a', ['a/x'], ['a/x'], { split: 'holdout', language: 'go' }), outcome('b', [], [])], ['a/x']);
    expect(report.version).toBe(1);
    expect(Object.keys(report.bySplit)).toEqual(['dev', 'holdout']);
    expect(Object.keys(report.byLanguage)).toEqual(['go', 'typescript']);
    expect(report.byRule['a/x']?.tp).toBe(1);
  });
});

describe('rule catalog', () => {
  it('matches every literal rule ID emitted by the shipped analyzers', () => {
    const dir = path.join(__dirname, '../../src/analyzers');
    const emitted = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      for (const match of readFileSync(path.join(dir, file), 'utf8').matchAll(/'((?:contracts|errors|cross-stack|secrets|dependencies|config|tests)\/[a-z0-9-]+)'/g)) {
        if (match[1]) emitted.add(match[1]);
      }
    }
    const catalog = new Set(ANALYZER_RULES);
    expect([...emitted].filter((id) => !catalog.has(id))).toEqual([]);
    // Secret pattern rules are built from the pattern catalog (`secrets/${id}`), so they are not literals.
    expect(ANALYZER_RULES.filter((id) => !emitted.has(id) && !id.startsWith('secrets/'))).toEqual([]);
  });
});
