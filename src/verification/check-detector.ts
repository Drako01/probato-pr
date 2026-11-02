import { msg, render, tr, type Message } from '../core/i18n';
import type { CheckKind, CommandSpec, OutputFormat, PlannedCheck } from '../core/model';

/** Read-only view of repository files needed to plan checks (injected for testability). */
export interface ProjectProbe {
  readText(relative: string): Promise<string | undefined>;
  exists(relative: string): Promise<boolean>;
}

type PackageManager = 'pnpm' | 'yarn' | 'npm';

const SCRIPT_KINDS: readonly { readonly kind: CheckKind; readonly names: readonly string[] }[] = [
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'check-types', 'types', 'tsc'] },
  { kind: 'lint', names: ['lint'] },
  { kind: 'test', names: ['test', 'test:unit', 'unit'] },
  { kind: 'build', names: ['build', 'compile'] },
];

/** Patterns in scripts or project files suggesting the command needs infrastructure beyond the repo. */
const INFRA_HINTS: readonly { readonly pattern: RegExp; readonly label: Message }[] = [
  { pattern: /\bdocker\b|docker-compose|\bcompose\b|testcontainers/i, label: msg('Docker') },
  { pattern: /DATABASE_URL|postgres|\bpg\b|mysql|mariadb|mongo|prisma (?:migrate|db)/i, label: msg('a database') },
  { pattern: /\bredis\b/i, label: msg('Redis') },
  { pattern: /playwright|cypress|puppeteer|selenium/i, label: msg('a browser (E2E tooling)') },
  { pattern: /\bAWS_|\bGCP_|\bAZURE_|\.env\b|dotenv/i, label: msg('credentials or environment variables') },
];

const NPM_DEFAULT_TEST = /no test specified/;
const SAFE_SCRIPT_NAME = /^[\w:.-]+$/;

async function packageManagerOf(probe: ProjectProbe): Promise<PackageManager> {
  if (await probe.exists('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (await probe.exists('yarn.lock')) {
    return 'yarn';
  }
  return 'npm';
}

function scriptCommand(pm: PackageManager, script: string): CommandSpec {
  return pm === 'npm' ? { executable: 'npm', args: ['run', '--silent', script] } : { executable: pm, args: ['run', script] };
}

function infraNeeds(text: string): string[] {
  return INFRA_HINTS.filter((h) => h.pattern.test(text)).map((h) => render(h.label));
}

/**
 * Builds the verification plan from tools already present in the project. Never proposes
 * installing anything; when dependencies are missing the plan says so instead of hiding the check.
 */
export async function detectChecks(probe: ProjectProbe): Promise<PlannedCheck[]> {
  const checks: PlannedCheck[] = [];
  const packageText = await probe.readText('package.json');
  if (packageText !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(packageText) as { scripts?: unknown };
      if (typeof parsed.scripts === 'object' && parsed.scripts !== null) {
        scripts = parsed.scripts as Record<string, unknown>;
      }
    } catch {
      // Invalid package.json: no scripts can be planned; the analyzers/tooling will surface the syntax error.
    }
    const pm = await packageManagerOf(probe);
    const hasNodeModules = await probe.exists('node_modules');
    const dependencyWarning = hasNodeModules
      ? []
      : [tr('node_modules is missing: dependencies are not installed, so this check will likely fail. Probato PR never installs dependencies.')];
    const [composeFile, envFile] = await Promise.all([
      probe.exists('docker-compose.yml').then(async (a) => a || (await probe.exists('compose.yaml'))),
      probe.exists('.env'),
    ]);
    const taken = new Set<CheckKind>();

    for (const { kind, names } of SCRIPT_KINDS) {
      const name = names.find((n) => typeof scripts[n] === 'string');
      if (name === undefined || !SAFE_SCRIPT_NAME.test(name)) {
        continue;
      }
      const body = scripts[name] as string;
      if (kind === 'test' && NPM_DEFAULT_TEST.test(body)) {
        continue;
      }
      taken.add(kind);
      const requires = infraNeeds(body);
      if (kind === 'test' && composeFile && requires.length === 0) {
        requires.push(tr('possibly Docker services (a compose file exists)'));
      }
      if (kind === 'test' && envFile) {
        requires.push(tr('environment variables from .env'));
      }
      checks.push({
        id: `script:${name}`,
        kind,
        label: `${pm} run ${name}`,
        command: scriptCommand(pm, name),
        cwd: '',
        rationale: tr('Project script "{0}" ({1}).', name, kind),
        warnings: [tr('Executes repository code: "{0}": {1}', name, body.slice(0, 300)), ...dependencyWarning],
        requires,
        outputFormat: /\btsc\b/.test(body) ? 'tsc' : /\bgo (?:build|vet)\b/.test(body) ? 'go' : 'plain',
      });
    }

    if (!taken.has('typecheck') && (await probe.exists('tsconfig.json')) && (await probe.exists('node_modules/typescript/bin/tsc'))) {
      checks.unshift({
        id: 'tsc:noEmit',
        kind: 'typecheck',
        label: 'tsc --noEmit',
        command: { executable: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'] },
        cwd: '',
        rationale: tr('The project has a tsconfig.json and a locally installed TypeScript compiler.'),
        warnings: [tr('Runs the TypeScript compiler installed in node_modules (no repository scripts).')],
        requires: [],
        outputFormat: 'tsc',
      });
    }
  }

  if (await probe.exists('go.mod')) {
    const goChecks: readonly { kind: CheckKind; sub: string; format: OutputFormat }[] = [
      { kind: 'build', sub: 'build', format: 'go' },
      { kind: 'vet', sub: 'vet', format: 'go' },
      { kind: 'test', sub: 'test', format: 'plain' },
    ];
    for (const { kind, sub, format } of goChecks) {
      checks.push({
        id: `go:${sub}`,
        kind,
        label: `go ${sub} ./...`,
        command: { executable: 'go', args: [sub, './...'] },
        cwd: '',
        rationale: tr('Go module detected (go.mod); standard go {0}.', sub),
        warnings:
          sub === 'test'
            ? [tr('Executes the repository test code.'), tr('May download modules if they are not cached (network).')]
            : [tr('May download modules if they are not cached (network).')],
        requires: [],
        outputFormat: format,
      });
    }
  }
  return checks;
}
