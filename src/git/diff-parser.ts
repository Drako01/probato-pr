import type { ChangeStatus, DiffHunk, DiffLine, FileChange } from '../core/model';

// Parses `git diff` output produced with --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const C_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };

/** Decodes git's C-style quoted paths ("a/caf\303\251.ts"), including octal UTF-8 byte escapes. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body.charAt(i + 1);
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(C_ESCAPES[next] ?? next, 'utf8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string {
  const unquoted = unquoteGitPath(p);
  return unquoted.startsWith(prefix) ? unquoted.slice(2) : unquoted;
}

/** Extracts paths from "diff --git a/x b/x" when no ---/+++ lines exist (binary or mode-only changes). */
function pathsFromHeader(rest: string): { oldPath: string; newPath: string } | undefined {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (m?.[1] && m[2]) {
      return { oldPath: stripPrefix(m[1], 'a/'), newPath: stripPrefix(m[2], 'b/') };
    }
    return undefined;
  }
  // Unquoted and symmetric: "a/P b/P" has length 2*len(P) + 5.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half)) {
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return { oldPath: left.slice(2), newPath: right.slice(2) };
    }
  }
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m?.[1] && m[2] ? { oldPath: m[1], newPath: m[2] } : undefined;
}

interface FileBuilder {
  oldPath: string | undefined;
  newPath: string | undefined;
  status: ChangeStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function build(file: FileBuilder): FileChange | undefined {
  const path = file.status === 'deleted' ? file.oldPath : (file.newPath ?? file.oldPath);
  if (!path) {
    return undefined;
  }
  const renamed = file.status === 'renamed' || file.status === 'copied';
  return {
    path,
    ...(renamed && file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    binary: file.binary,
    hunks: file.hunks,
    additions: file.additions,
    deletions: file.deletions,
  };
}

export function parseUnifiedDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = text.split('\n');
  let current: FileBuilder | undefined;
  let hunk: { header: DiffHunk; lines: DiffLine[]; oldLine: number; newLine: number } | undefined;

  const closeHunk = (): void => {
    if (current && hunk) {
      current.hunks.push({ ...hunk.header, lines: hunk.lines });
    }
    hunk = undefined;
  };
  const closeFile = (): void => {
    closeHunk();
    if (current) {
      const built = build(current);
      if (built) {
        files.push(built);
      }
    }
    current = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      closeFile();
      const paths = pathsFromHeader(line.slice('diff --git '.length));
      current = {
        oldPath: paths?.oldPath,
        newPath: paths?.newPath,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (hunk) {
      const marker = line.charAt(0);
      if (marker === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1).replace(/\r$/, ''), newLine: hunk.newLine++ });
        current.additions++;
        continue;
      }
      if (marker === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1).replace(/\r$/, ''), oldLine: hunk.oldLine++ });
        current.deletions++;
        continue;
      }
      if (marker === ' ') {
        hunk.lines.push({ kind: 'context', text: line.slice(1).replace(/\r$/, ''), oldLine: hunk.oldLine++, newLine: hunk.newLine++ });
        continue;
      }
      if (marker === '\\') {
        continue; // "\ No newline at end of file"
      }
      closeHunk();
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[3]);
      hunk = {
        header: {
          oldStart,
          oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
          newStart,
          newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
          header: hunkMatch[5] ?? '',
          lines: [],
        },
        lines: [],
        oldLine: oldStart,
        newLine: newStart,
      };
    } else if (line.startsWith('new file mode')) {
      current.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquoteGitPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      current.newPath = unquoteGitPath(line.slice('rename to '.length));
    } else if (line.startsWith('copy from ')) {
      current.status = 'copied';
      current.oldPath = unquoteGitPath(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      current.newPath = unquoteGitPath(line.slice('copy to '.length));
    } else if (line.startsWith('old mode') || line.startsWith('new mode')) {
      // permission-only change: keep status
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t$/, '');
      if (p !== '/dev/null') {
        current.oldPath = stripPrefix(p, 'a/');
      }
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, '');
      if (p !== '/dev/null') {
        current.newPath = stripPrefix(p, 'b/');
      }
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
    }
  }
  closeFile();
  return files;
}

/** Lines added on the head side, with their head line numbers. */
export function addedLines(file: FileChange): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newLine !== undefined) {
        result.push({ line: l.newLine, text: l.text });
      }
    }
  }
  return result;
}

/** Lines removed from the base side, with their base line numbers. */
export function deletedLines(file: FileChange): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'del' && l.oldLine !== undefined) {
        result.push({ line: l.oldLine, text: l.text });
      }
    }
  }
  return result;
}

/** True when the head-side line is part of the change (added or modified). */
export function isChangedLine(file: FileChange, headLine: number): boolean {
  return addedLines(file).some((l) => l.line === headLine);
}

/** Synthesizes an all-added FileChange for an untracked file. */
export function untrackedFileChange(path: string, content: string): FileChange {
  const textLines = content.split('\n');
  if (textLines.length > 0 && textLines[textLines.length - 1] === '') {
    textLines.pop();
  }
  return {
    path,
    status: 'added',
    binary: content.includes('\0'),
    hunks: content.includes('\0')
      ? []
      : [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: textLines.length,
            header: '',
            lines: textLines.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
          },
        ],
    additions: textLines.length,
    deletions: 0,
  };
}
