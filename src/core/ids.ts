import { createHash, randomUUID } from 'node:crypto';

/** Deterministic short id: the same inputs always produce the same id across runs. */
export function stableId(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export function uniqueId(): string {
  return randomUUID();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
