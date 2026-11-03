import { createDefaultAnalyzers } from './analyzers';
import { withIncrementalCache } from './infrastructure/review-cache';

/** Loaded only when a review starts; keeps the TypeScript compiler out of extension activation. */
export function createAnalyzers(version: string) {
  return withIncrementalCache(createDefaultAnalyzers(), version);
}
