import { describe, expect, it } from 'vitest';
import { percentile, profileOf, summarize, type PerfSample } from '../../scripts/perf-real.mjs';

const sample = (wallMs: number, overrides: Partial<PerfSample> = {}): PerfSample => ({ execution: 'first', profile: 'small', wallMs, peakRssBytes: 100, exitCode: 0, ...overrides });

describe('real-repository performance statistics (scripts/perf-real.mjs)', () => {
  it('uses nearest-rank percentiles and never invents a value for an empty sample', () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
    expect(() => percentile([1], 0)).toThrow(RangeError);
  });

  it('classifies change profiles at the documented boundary', () => {
    expect(profileOf({ files: 10, lines: 300 })).toBe('small');
    expect(profileOf({ files: 11, lines: 1 })).toBe('large');
    expect(profileOf({ files: 1, lines: 301 })).toBe('large');
  });

  it('counts failed runs separately and keeps them out of the timings', () => {
    const summary = summarize([sample(10), sample(30, { peakRssBytes: 500 }), sample(9_999, { exitCode: 2, peakRssBytes: 9_999 }), sample(20, { exitCode: 1 })]);
    expect(summary).toEqual({ runs: 4, failures: 1, p50Ms: 20, p95Ms: 30, maxMs: 30, peakRssBytes: 500 });
    expect(summarize([])).toEqual({ runs: 0, failures: 0, p50Ms: undefined, p95Ms: undefined, maxMs: undefined, peakRssBytes: undefined });
  });
});
