import type { OutputFormat } from '../core/model';

export interface ToolDiagnostic {
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

// tsc --pretty false: "src/a.ts(12,5): error TS2305: Module './b' has no exported member 'x'."
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
// go build / go vet: "./pkg/a.go:12:5: undefined: Foo" or "pkg/a.go:12:5: ..."
const GO_LINE = /^(?:vet: )?(\.?\.?\/?[^\s:]+\.go):(\d+)(?::(\d+))?: (.+)$/;

function normalize(file: string, cwd: string): string | undefined {
  const posix = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^[a-z]:\//i.test(posix) || posix.startsWith('/') || posix.split('/').includes('..')) {
    return undefined; // outside the checked directory: not attributable to repository files
  }
  return cwd ? `${cwd}/${posix}` : posix;
}

export function parseDiagnostics(output: string, format: OutputFormat, cwd = ''): ToolDiagnostic[] {
  if (format === 'plain') {
    return [];
  }
  const diagnostics: ToolDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const match = format === 'tsc' ? TSC_LINE.exec(line) : GO_LINE.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const file = normalize(match[1], cwd);
    if (!file) {
      continue;
    }
    diagnostics.push(
      format === 'tsc'
        ? { file, line: Number(match[2]), column: Number(match[3]), code: match[4] ?? 'TS', message: match[5] ?? '' }
        : { file, line: Number(match[2]), column: Number(match[3] ?? 1), code: 'go', message: match[4] ?? '' },
    );
  }
  return diagnostics;
}

/** Line-independent identity of a diagnostic, so base and head can be compared despite shifted lines. */
export function fingerprint(d: ToolDiagnostic): string {
  return `${d.file}|${d.code}|${d.message}`;
}
