import { describe, expect, it } from 'vitest';
import type { FileChange } from '../../src/core/model';
import { addedLines, deletedLines, parseUnifiedDiff, unquoteGitPath, untrackedFileChange } from '../../src/git/diff-parser';

function must(file: FileChange | undefined): FileChange {
  if (!file) {
    throw new Error('expected a parsed file');
  }
  return file;
}

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 console.log(a);
 console.log(b);
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file with exact line numbers on both sides', () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file?.path).toBe('src/app.ts');
    expect(file?.status).toBe('modified');
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.header).toBe('export function main() {');
    expect(addedLines(must(file))).toEqual([
      { line: 2, text: 'const b = 3;' },
      { line: 3, text: 'const c = 4;' },
    ]);
    expect(deletedLines(must(file))).toEqual([{ line: 2, text: 'const b = 2;' }]);
  });

  it('detects added, deleted, renamed and binary files', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+export const x = 1;
diff --git a/old.ts b/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const y = 2;
diff --git a/src/a.ts b/src/b.ts
similarity index 90%
rename from src/a.ts
rename to src/b.ts
index 5555555..6666666 100644
--- a/src/a.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['new.ts', 'added', false],
      ['old.ts', 'deleted', false],
      ['src/b.ts', 'renamed', false],
      ['logo.png', 'modified', true],
    ]);
    expect(files[2]?.oldPath).toBe('src/a.ts');
  });

  it('handles paths with spaces, quoted unicode and no newline markers', () => {
    const diff = `diff --git "a/caf\\303\\251 file.ts" "b/caf\\303\\251 file.ts"
index 1..2 100644
--- "a/caf\\303\\251 file.ts"
+++ "b/caf\\303\\251 file.ts"
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
diff --git a/dir with space/x.ts b/dir with space/x.ts
old mode 100644
new mode 100755
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]?.path).toBe('café file.ts');
    expect(files[0]?.additions).toBe(1);
    expect(files[1]?.path).toBe('dir with space/x.ts');
  });

  it('keeps deleted lines that look like file headers inside a hunk', () => {
    const diff = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1,2 +1,1 @@
--- not a header
 keep
`;
    const [file] = parseUnifiedDiff(diff);
    expect(deletedLines(must(file))).toEqual([{ line: 1, text: '-- not a header' }]);
  });

  it('returns no files for empty output', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('strips CR from CRLF content', () => {
    const [file] = parseUnifiedDiff('diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@\n-a\r\n+b\r\n');
    expect(addedLines(must(file))[0]?.text).toBe('b');
  });
});

describe('helpers', () => {
  it('unquotes C-style escapes', () => {
    expect(unquoteGitPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquoteGitPath('plain')).toBe('plain');
  });

  it('synthesizes untracked files as fully added', () => {
    const change = untrackedFileChange('n.ts', 'one\ntwo\n');
    expect(change.additions).toBe(2);
    expect(addedLines(change).map((l) => l.line)).toEqual([1, 2]);
    expect(untrackedFileChange('bin', 'a\0b').binary).toBe(true);
  });
});
