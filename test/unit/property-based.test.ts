import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/core/secrets';
import { addedLines, deletedLines, parseUnifiedDiff, unquoteGitPath } from '../../src/git/diff-parser';

// Property-based tests with a seeded PRNG (no extra dependency). Reproduce a failure with
// PROBATO_FUZZ_SEED=<seed> pnpm exec vitest run test/unit/property-based.test.ts; every assertion message carries
// the seed and the case index. There is no automatic shrinking: cases grow with the index, so the first failing
// index is already the smallest generated counterexample for that seed.
const SEED = Number(process.env.PROBATO_FUZZ_SEED ?? 20261108);
const RUNS = 300;

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

type Gen = { int: (max: number) => number; pick: <T>(items: readonly T[]) => T; text: (max: number, alphabet?: string) => string };
function gen(random: () => number): Gen {
  const int = (max: number): number => Math.floor(random() * (max + 1));
  const pick = <T,>(items: readonly T[]): T => items[int(items.length - 1)] as T;
  const BASE = 'abcXYZ019 _-./(){}[];:=+"\'\\\té€中😀';
  // Code points on purpose: lone surrogates are not valid paths or source text.
  const text = (max: number, alphabet = BASE): string => Array.from({ length: int(max) }, () => pick(Array.from(alphabet))).join('');
  return { int, pick, text };
}

function forAll(property: (g: Gen, size: number, label: string) => void): void {
  const random = prng(SEED);
  for (let index = 0; index < RUNS; index++) property(gen(random), 1 + Math.floor(index / 30), `seed=${SEED} case=${index}`);
}

/** Git-style C quoting: only when the path needs it, octal for every non-ASCII byte. */
function quoteGitPath(path: string): string {
  if (!/[^\x20-\x7e]|["\\]/.test(path)) return path;
  const escapes: Record<number, string> = { 0x0a: '\\n', 0x09: '\\t', 0x22: '\\"', 0x5c: '\\\\' };
  let body = '';
  for (const byte of Buffer.from(path, 'utf8')) {
    body += escapes[byte] ?? (byte < 0x20 || byte > 0x7e ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte));
  }
  return `"${body}"`;
}

describe('property: git path quoting', () => {
  it('unquoteGitPath inverts git C quoting for arbitrary UTF-8 paths', () => {
    forAll((g, size, label) => {
      const path = g.text(4 * size, 'ab/.é中😀"\\\t\n -');
      expect(unquoteGitPath(quoteGitPath(path)), label).toBe(path);
    });
  });
});

describe('property: unified diff parser', () => {
  it('recovers paths, counts and line numbers of generated diffs', () => {
    forAll((g, size, label) => {
      const files = Array.from({ length: 1 + g.int(size) }, (_, index) => ({
        path: `${g.text(2 * size, 'ab é中"\\-') || 'f'}/${index}.ts`,
        hunks: [] as { oldStart: number; newStart: number; lines: { kind: 'add' | 'del' | 'context'; text: string }[] }[],
      }));
      let diff = '';
      for (const file of files) {
        const quotedA = quoteGitPath(`a/${file.path}`), quotedB = quoteGitPath(`b/${file.path}`);
        const tab = file.path.includes(' ') && !quotedA.startsWith('"') ? '\t' : '';
        diff += `diff --git ${quotedA} ${quotedB}\nindex 1111111..2222222 100644\n--- ${quotedA}${tab}\n+++ ${quotedB}${tab}\n`;
        let oldStart = 1 + g.int(5), newStart = oldStart;
        for (let h = 0; h < 1 + g.int(size); h++) {
          const lines = Array.from({ length: 1 + g.int(3 * size) }, () => ({ kind: g.pick(['add', 'del', 'context'] as const), text: g.text(20) }));
          const oldCount = lines.filter((l) => l.kind !== 'add').length, newCount = lines.filter((l) => l.kind !== 'del').length;
          file.hunks.push({ oldStart, newStart, lines });
          diff += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@ ${g.text(10)}\n`;
          for (const line of lines) diff += `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}${g.int(9) === 0 ? '\r' : ''}\n`;
          if (g.int(5) === 0) diff += '\\ No newline at end of file\n';
          oldStart += oldCount + 1 + g.int(5);
          newStart += newCount + 1 + g.int(5);
        }
      }
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.map((f) => f.path), label).toEqual(files.map((f) => f.path));
      parsed.forEach((change, index) => {
        const expected = files[index];
        if (!expected) throw new Error(`${label}: unexpected file ${change.path}`);
        const adds = expected.hunks.flatMap((h) => { let n = h.newStart; return h.lines.flatMap((l) => (l.kind === 'del' ? [] : l.kind === 'add' ? [{ line: n++, text: l.text }] : (n++, []))); });
        const dels = expected.hunks.flatMap((h) => { let n = h.oldStart; return h.lines.flatMap((l) => (l.kind === 'add' ? [] : l.kind === 'del' ? [{ line: n++, text: l.text }] : (n++, []))); });
        expect(addedLines(change), label).toEqual(adds);
        expect(deletedLines(change), label).toEqual(dels);
        expect(change.additions, label).toBe(adds.length);
        expect(change.deletions, label).toBe(dels.length);
        expect(change.hunks, label).toHaveLength(expected.hunks.length);
      });
    });
  });

  it('never throws and never invents files on arbitrary input', () => {
    forAll((g, size, label) => {
      const noise = Array.from({ length: 5 * size }, () => g.pick(['diff --git ', '@@ -1 +1 @@', '+', '-', ' ', '\\', '--- ', '+++ ', 'rename from ', 'Binary files ', '']) + g.text(12)).join('\n');
      const parsed = parseUnifiedDiff(noise);
      expect(parsed.length, label).toBeLessThanOrEqual((noise.match(/^diff --git /gm) ?? []).length);
      for (const file of parsed) expect(file.additions + file.deletions, label).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('property: secret redaction', () => {
  const TOKENS: readonly ((g: Gen) => string)[] = [
    (g) => `ghp_${g.text(36, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').padEnd(36, 'a')}`,
    (g) => `AKIA${g.text(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567').padEnd(16, 'Q')}`,
    (g) => `sk-ant-${g.text(30, 'abcdefXYZ0123_-').padEnd(24, 'x')}`,
    (g) => `xoxb-${g.text(20, 'abc0123-').padEnd(12, '1')}`,
    (g) => `postgres://user:${g.text(10, 'abcdef123').padEnd(6, 'p')}@db.example.com:5432/app`,
  ];

  it('removes every embedded token and is idempotent', () => {
    forAll((g, size, label) => {
      const tokens = Array.from({ length: 1 + g.int(size) }, () => g.pick(TOKENS)(g));
      const separators = [' ', '\n', '"', "'", '=', ': ', '\t'];
      const text = tokens.map((token) => `${g.text(10, 'lorem ipsum ,.;\n')}${g.pick(separators)}${token}${g.pick(separators)}`).join('');
      const redacted = redactSecrets(text);
      for (const token of tokens) expect(redacted, `${label} leaked ${token}`).not.toContain(token);
      expect(redactSecrets(redacted), label).toBe(redacted);
    });
  });

  it('leaves text without secrets unchanged', () => {
    forAll((g, size, label) => {
      const text = g.text(40 * size, 'lorem ipsum dolor sit amet,.;\n()0123');
      expect(redactSecrets(text), label).toBe(text);
    });
  });
});
