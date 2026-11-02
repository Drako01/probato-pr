/**
 * Maps items with at most `limit` operations in flight. Results keep the order of `items`, so callers
 * behave exactly as with a sequential loop. Stops starting new work once `signal` is aborted
 * (the remaining slots stay `undefined`).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      results[index] = await operation(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
