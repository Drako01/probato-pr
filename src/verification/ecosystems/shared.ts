import { msg, render, type Message } from '../../core/i18n';
import type { CheckKind, CommandSpec, OutputFormat, PlannedCheck } from '../../core/model';

/** Read-only view of repository files needed to plan checks (injected for testability). */
export interface ProjectProbe {
  readText(relative: string): Promise<string | undefined>;
  exists(relative: string): Promise<boolean>;
}

export interface DetectionContext {
  readonly probe: ProjectProbe;
  /** Decides interpreter paths and how wrapper scripts are started. */
  readonly platform: NodeJS.Platform;
}

/** A planned check before its fingerprint; `scriptBody` is the repository code it runs, when known. */
export interface CheckDraft {
  readonly check: Omit<PlannedCheck, 'fingerprint'>;
  readonly scriptBody?: string;
}

/** One language or build tool: returns the checks it finds, in the order they should be offered. */
export type Ecosystem = (context: DetectionContext) => Promise<readonly CheckDraft[]>;

/** Script names passed to package managers; also safe through cmd.exe on Windows. */
export const SAFE_SCRIPT_NAME = /^[\w:.-]+$/;

/** Patterns in scripts or project files suggesting the command needs infrastructure beyond the repo. */
const INFRA_HINTS: readonly { readonly pattern: RegExp; readonly label: Message }[] = [
  { pattern: /\bdocker\b|docker-compose|\bcompose\b|testcontainers/i, label: msg('Docker') },
  { pattern: /DATABASE_URL|postgres|\bpg\b|mysql|mariadb|mongo|prisma (?:migrate|db)/i, label: msg('a database') },
  { pattern: /\bredis\b/i, label: msg('Redis') },
  { pattern: /playwright|cypress|puppeteer|selenium/i, label: msg('a browser (E2E tooling)') },
  { pattern: /\bAWS_|\bGCP_|\bAZURE_|\.env\b|dotenv/i, label: msg('credentials or environment variables') },
];

/** Whether any of the repository-relative paths exists. */
export async function anyExists(probe: ProjectProbe, paths: readonly string[]): Promise<boolean> {
  return (await Promise.all(paths.map((p) => probe.exists(p)))).some(Boolean);
}

export function infraNeeds(text: string): string[] {
  return INFRA_HINTS.filter((h) => h.pattern.test(text)).map((h) => render(h.label));
}

/** Every check runs from the repository root; the fields that vary per tool are the ones passed here. */
export function toolCheck(fields: {
  readonly id: string;
  readonly kind: CheckKind;
  readonly label: string;
  readonly command: CommandSpec;
  readonly rationale: string;
  readonly warnings: readonly string[];
  readonly outputFormat: OutputFormat;
  readonly runsRepositoryCode: boolean;
  readonly requires?: readonly string[];
  readonly scriptBody?: string;
}): CheckDraft {
  const { scriptBody, requires = [], ...check } = fields;
  return { check: { ...check, cwd: '', requires }, ...(scriptBody !== undefined ? { scriptBody } : {}) };
}

/**
 * Starts a wrapper script committed to the repository (`gradlew`, `mvnw`). On Windows cmd.exe finds the
 * `.bat`/`.cmd` next to it; elsewhere `sh` runs it even when the executable bit was lost in Git.
 */
export function wrapperCommand(wrapper: string, args: readonly string[], platform: NodeJS.Platform): CommandSpec {
  return platform === 'win32' ? { executable: wrapper, args: [...args] } : { executable: 'sh', args: [wrapper, ...args] };
}

/** First of the kinds' candidate names that the project defines as a script. */
export function firstScript(scripts: Readonly<Record<string, unknown>>, names: readonly string[]): string | undefined {
  return names.find((name) => scripts[name] !== undefined && SAFE_SCRIPT_NAME.test(name));
}

/** The `scripts` object of a JSON manifest, or empty when the file is missing or invalid. */
export function scriptsOf(manifest: string | undefined): Readonly<Record<string, unknown>> {
  if (manifest === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(manifest) as { scripts?: unknown };
    return typeof parsed.scripts === 'object' && parsed.scripts !== null ? (parsed.scripts as Record<string, unknown>) : {};
  } catch {
    // Invalid manifest: no scripts can be planned; the tool itself reports the syntax error when it runs.
    return {};
  }
}
