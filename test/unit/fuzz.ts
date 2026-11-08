// Seeded property-based testing without an extra dependency. Reproduce a failure with
// PROBATO_FUZZ_SEED=<seed> pnpm exec vitest run <file>; every assertion message carries the seed and the case
// index. There is no automatic shrinking: cases grow with the index, so the first failing index is already the
// smallest generated counterexample for that seed.
export const SEED = Number(process.env.PROBATO_FUZZ_SEED ?? 20261108);
export const RUNS = 300;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Gen = { int: (max: number) => number; pick: <T>(items: readonly T[]) => T; text: (max: number, alphabet?: string) => string };
function gen(random: () => number): Gen {
  const int = (max: number): number => Math.floor(random() * (max + 1));
  const pick = <T,>(items: readonly T[]): T => items[int(items.length - 1)] as T;
  const BASE = 'abcXYZ019 _-./(){}[];:=+"\'\\\té€中😀';
  // Code points on purpose: lone surrogates are not valid paths or source text.
  const text = (max: number, alphabet = BASE): string => Array.from({ length: int(max) }, () => pick(Array.from(alphabet))).join('');
  return { int, pick, text };
}

export function forAll(property: (g: Gen, size: number, label: string) => void): void {
  const random = prng(SEED);
  for (let index = 0; index < RUNS; index++) property(gen(random), 1 + Math.floor(index / 30), `seed=${SEED} case=${index}`);
}
