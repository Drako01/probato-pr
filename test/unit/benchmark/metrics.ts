// Pure scoring for the labeled benchmark: per-case outcomes aggregated overall, by split, by language and by rule,
// with Wilson score intervals. No I/O; the report shape is versioned so stored reports stay comparable.

export const BENCHMARK_REPORT_VERSION = 1;

export interface CaseOutcome {
  readonly id: string;
  readonly language: string;
  readonly split: string;
  readonly expected: readonly string[];
  readonly reported: readonly string[];
  /** At least one applicable analyzer failed, so the absence of a finding proves nothing. */
  readonly inconclusive: boolean;
}

export interface Interval {
  readonly value: number;
  /** 95% Wilson score interval. */
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

export interface Tally {
  readonly cases: number;
  readonly traps: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Undefined when nothing was reported (no denominator), never reported as 1. */
  readonly precision: Interval | undefined;
  /** Undefined when nothing was expected. */
  readonly recall: Interval | undefined;
  readonly f1: number | undefined;
  readonly falsePositivesPerCase: number;
  /** Traps on which at least one finding was reported. */
  readonly noisyTraps: number;
  readonly inconclusiveRate: number;
}

const Z95 = 1.959963984540054;

/** Wilson score interval for `successes / n`; undefined for an empty sample. */
export function wilson(successes: number, n: number, z = Z95): Interval | undefined {
  if (n === 0) return undefined;
  const p = successes / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  // The bounds are exactly 0 / 1 at the extremes; the closed form only approximates them in floating point.
  return { value: p, low: successes === 0 ? 0 : Math.max(0, center - half), high: successes === n ? 1 : Math.min(1, center + half), n };
}

interface Counts { tp: number; fp: number; fn: number }

function countsOf(outcome: CaseOutcome, rule?: string): Counts {
  const keep = (id: string): boolean => rule === undefined || id === rule;
  const expected = new Set(outcome.expected.filter(keep));
  const reported = new Set(outcome.reported.filter(keep));
  const tp = [...expected].filter((id) => reported.has(id)).length;
  return { tp, fn: expected.size - tp, fp: [...reported].filter((id) => !expected.has(id)).length };
}

/** Aggregates outcomes; with `rule`, only that rule's expectations and reports are counted. */
export function tally(outcomes: readonly CaseOutcome[], rule?: string): Tally {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let noisyTraps = 0;
  for (const outcome of outcomes) {
    const counts = countsOf(outcome, rule);
    tp += counts.tp;
    fp += counts.fp;
    fn += counts.fn;
    if (outcome.expected.length === 0 && counts.fp > 0) noisyTraps++;
  }
  const precision = wilson(tp, tp + fp);
  const recall = wilson(tp, tp + fn);
  const f1 = precision && recall && precision.value + recall.value > 0 ? (2 * precision.value * recall.value) / (precision.value + recall.value) : undefined;
  return {
    cases: outcomes.length,
    traps: outcomes.filter((o) => o.expected.length === 0).length,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    falsePositivesPerCase: outcomes.length === 0 ? 0 : fp / outcomes.length,
    noisyTraps,
    inconclusiveRate: outcomes.length === 0 ? 0 : outcomes.filter((o) => o.inconclusive).length / outcomes.length,
  };
}

function groupBy(outcomes: readonly CaseOutcome[], key: (o: CaseOutcome) => string): Record<string, Tally> {
  const groups = new Map<string, CaseOutcome[]>();
  for (const outcome of outcomes) groups.set(key(outcome), [...(groups.get(key(outcome)) ?? []), outcome]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, tally(groups.get(k) ?? [])]));
}

export interface BenchmarkReport {
  readonly version: typeof BENCHMARK_REPORT_VERSION;
  readonly corpus: { readonly id: string; readonly provenance: string; readonly holdoutSeal: string };
  readonly overall: Tally;
  readonly bySplit: Record<string, Tally>;
  readonly byLanguage: Record<string, Tally>;
  /** Per rule, every case counts: a case without the rule can still produce a false positive of it. */
  readonly byRule: Record<string, Tally>;
}

export function buildReport(corpus: BenchmarkReport['corpus'], outcomes: readonly CaseOutcome[], rules: readonly string[]): BenchmarkReport {
  return {
    version: BENCHMARK_REPORT_VERSION,
    corpus,
    overall: tally(outcomes),
    bySplit: groupBy(outcomes, (o) => o.split),
    byLanguage: groupBy(outcomes, (o) => o.language),
    byRule: Object.fromEntries([...rules].sort().map((rule) => [rule, tally(outcomes, rule)])),
  };
}

const pct = (i: Interval | undefined): string => (i ? `${(i.value * 100).toFixed(1)}% [${(i.low * 100).toFixed(1)}–${(i.high * 100).toFixed(1)}] n=${i.n}` : 'n/a');

/** One line per group, for test logs and the evidence document. */
export function formatTally(label: string, t: Tally): string {
  return `${label}: cases=${t.cases} traps=${t.traps} TP=${t.tp} FP=${t.fp} FN=${t.fn} precision=${pct(t.precision)} recall=${pct(t.recall)} F1=${t.f1?.toFixed(3) ?? 'n/a'} FP/case=${t.falsePositivesPerCase.toFixed(3)} noisyTraps=${t.noisyTraps} inconclusive=${(t.inconclusiveRate * 100).toFixed(1)}%`;
}
