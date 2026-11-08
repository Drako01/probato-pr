export interface PerfSample {
  readonly execution: 'first' | 'second';
  readonly profile: 'small' | 'large';
  readonly wallMs: number;
  readonly peakRssBytes: number | undefined;
  readonly exitCode: number | null;
}

export interface PerfSummary {
  readonly runs: number;
  readonly failures: number;
  readonly p50Ms: number | undefined;
  readonly p95Ms: number | undefined;
  readonly maxMs: number | undefined;
  readonly peakRssBytes: number | undefined;
}

export const SMALL_CHANGE: { readonly files: number; readonly lines: number };

export function percentile(values: readonly number[], p: number): number | undefined;

export function profileOf(change: { readonly files: number; readonly lines: number }): 'small' | 'large';

export function summarize(samples: readonly PerfSample[]): PerfSummary;
