import type { OutputFormat } from '../core/model';

export interface ToolDiagnostic {
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Tool error code when the format has one (TS2305); empty otherwise. */
  readonly code: string;
  readonly message: string;
}

interface LinePattern {
  readonly regex: RegExp;
  readonly read: (match: RegExpExecArray) => {
    file: string | undefined;
    line: string | undefined;
    column: string | undefined;
    code?: string | undefined;
    message: string | undefined;
  };
}

const PATTERNS: Readonly<Record<Exclude<OutputFormat, 'plain'>, LinePattern>> = {
  // tsc --pretty false: "src/a.ts(12,5): error TS2305: Module './b' has no exported member 'x'."
  tsc: { regex: /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/, read: ([, file, line, column, code, message]) => ({ file, line, column, code, message }) },
  // go build / go vet: "./pkg/a.go:12:5: undefined: Foo" or "pkg/a.go:12:5: ..."
  go: { regex: /^(?:vet: )?(\.?\.?\/?[^\s:]+\.go):(\d+)(?::(\d+))?: (.+)$/, read: ([, file, line, column, message]) => ({ file, line, column, code: 'go', message }) },
  // "file:line[:column]: message": cargo --message-format=short, ruff --output-format=concise, mypy, phpstan
  // --error-format=raw, phpcs --report=emacs and javac through Gradle. The drive letter keeps Windows paths whole.
  gnu: { regex: /^((?:[A-Za-z]:)?[^:\s][^:]*):(\d+)(?::(\d+))?:\s*(.+)$/, read: ([, file, line, column, message]) => ({ file, line, column, message }) },
  // Maven compiler plugin: "[ERROR] /repo/src/main/java/A.java:[12,5] cannot find symbol"
  maven: { regex: /^\[ERROR\] (.+?):\[(\d+),(\d+)\] (.+)$/, read: ([, file, line, column, message]) => ({ file, line, column, message }) },
};

/**
 * Repository-relative path, or undefined when the file is outside the checked directory (not attributable).
 * Absolute paths are accepted when they are inside `runDirectory`, the absolute directory the command ran in.
 */
function normalize(file: string, cwd: string, runDirectory: string | undefined): string | undefined {
  // Maven on Windows writes URI-style paths ("/C:/repo/A.java"); drop the slash before the drive letter.
  let posix = file.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/([a-z]:\/)/i, '$1');
  const absolute = /^[a-z]:\//i.test(posix) || posix.startsWith('/');
  if (absolute) {
    const root = runDirectory?.replace(/\\/g, '/').replace(/\/+$/, '');
    const windows = root !== undefined && /^[a-z]:\//i.test(root);
    const inside = root !== undefined && (windows ? posix.toLowerCase().startsWith(`${root.toLowerCase()}/`) : posix.startsWith(`${root}/`));
    if (!inside) {
      return undefined;
    }
    posix = posix.slice(root.length + 1);
  }
  if (posix.split('/').includes('..')) {
    return undefined;
  }
  return cwd ? `${cwd}/${posix}` : posix;
}

/** Some tools color their output even when it is not a terminal (ruff does); colors would break every pattern. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

export function parseDiagnostics(output: string, format: OutputFormat, cwd = '', runDirectory?: string): ToolDiagnostic[] {
  if (format === 'plain') {
    return [];
  }
  const pattern = PATTERNS[format];
  const diagnostics: ToolDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const match = pattern.regex.exec(raw.trimEnd());
    const fields = match ? pattern.read(match) : undefined;
    if (!fields?.file || !fields.line) {
      continue;
    }
    const file = normalize(fields.file, cwd, runDirectory);
    if (!file) {
      continue;
    }
    const diagnostic = { file, line: Number(fields.line), column: Number(fields.column ?? 1), code: fields.code ?? '', message: fields.message ?? '' };
    // Maven prints each compiler error twice (as it happens and again in the build failure summary).
    const key = `${file}:${diagnostic.line}:${diagnostic.column}|${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

/** Line-independent identity of a diagnostic, so base and head can be compared despite shifted lines. */
export function fingerprint(d: ToolDiagnostic): string {
  return `${d.file}|${d.code}|${d.message}`;
}
