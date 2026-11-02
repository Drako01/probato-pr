import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../src/core/concurrency';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapLimit', () => {
  it('keeps the order of the items whatever order the operations finish in', async () => {
    const delays = [30, 1, 15, 1, 5];
    const result = await mapLimit(delays, 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });
    expect(peak).toBe(4);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, () => Promise.resolve(1))).toEqual([]);
  });

  it('stops starting work once the signal is aborted', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const result = await mapLimit(
      [0, 1, 2, 3, 4, 5],
      1,
      async (item) => {
        started.push(item);
        if (item === 1) {
          controller.abort();
        }
        await tick();
        return item;
      },
      controller.signal,
    );
    expect(started).toEqual([0, 1]);
    expect(result).toEqual([0, 1, undefined, undefined, undefined, undefined]);
  });
});
