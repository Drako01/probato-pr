/** Normalizes a caught value so callers keep failures typed as Error (and satisfy only-throw-error). */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Throws the single collected failure as is, or every failure together as an AggregateError. */
export function throwCollected(failures: readonly Error[], message: string): void {
  const [first, ...rest] = failures;
  if (!first) return;
  throw rest.length === 0 ? first : new AggregateError(failures, message);
}
