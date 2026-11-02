import { tr } from '../../core/i18n';
import type { CheckKind, CommandSpec } from '../../core/model';
import { firstScript, infraNeeds, scriptsOf, toolCheck, type CheckDraft, type Ecosystem } from './shared';

type PackageManager = 'pnpm' | 'yarn' | 'npm';

const SCRIPT_KINDS: readonly { readonly kind: CheckKind; readonly names: readonly string[] }[] = [
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'check-types', 'types', 'tsc'] },
  { kind: 'lint', names: ['lint'] },
  { kind: 'test', names: ['test', 'test:unit', 'unit'] },
  { kind: 'build', names: ['build', 'compile'] },
];

const NPM_DEFAULT_TEST = /no test specified/;

async function packageManagerOf(probe: { exists(relative: string): Promise<boolean> }): Promise<PackageManager> {
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

/** package.json scripts, plus the local TypeScript compiler when no type-check script exists. */
export const nodeChecks: Ecosystem = async ({ probe }) => {
  const manifest = await probe.readText('package.json');
  if (manifest === undefined) {
    return [];
  }
  const scripts = scriptsOf(manifest);
  const pm = await packageManagerOf(probe);
  const dependencyWarning = (await probe.exists('node_modules'))
    ? []
    : [tr('node_modules is missing: dependencies are not installed, so this check will likely fail. Probato PR never installs dependencies.')];
  const [composeFile, envFile] = await Promise.all([
    probe.exists('docker-compose.yml').then(async (a) => a || (await probe.exists('compose.yaml'))),
    probe.exists('.env'),
  ]);

  const drafts: CheckDraft[] = [];
  const taken = new Set<CheckKind>();
  for (const { kind, names } of SCRIPT_KINDS) {
    const name = firstScript(scripts, names);
    const body = name === undefined ? undefined : scripts[name];
    if (name === undefined || typeof body !== 'string' || (kind === 'test' && NPM_DEFAULT_TEST.test(body))) {
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
    drafts.push(
      toolCheck({
        id: `script:${name}`,
        kind,
        label: `${pm} run ${name}`,
        command: scriptCommand(pm, name),
        rationale: tr('Project script "{0}" ({1}).', name, kind),
        warnings: [tr('Executes repository code: "{0}": {1}', name, body.slice(0, 300)), ...dependencyWarning],
        requires,
        outputFormat: /\btsc\b/.test(body) ? 'tsc' : /\bgo (?:build|vet)\b/.test(body) ? 'go' : 'plain',
        runsRepositoryCode: true,
        scriptBody: body,
      }),
    );
  }

  if (!taken.has('typecheck') && (await probe.exists('tsconfig.json')) && (await probe.exists('node_modules/typescript/bin/tsc'))) {
    drafts.unshift(
      toolCheck({
        id: 'tsc:noEmit',
        kind: 'typecheck',
        label: 'tsc --noEmit',
        command: { executable: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'] },
        rationale: tr('The project has a tsconfig.json and a locally installed TypeScript compiler.'),
        warnings: [tr('Runs the TypeScript compiler installed in node_modules (no repository scripts).')],
        outputFormat: 'tsc',
        runsRepositoryCode: false,
      }),
    );
  }
  return drafts;
};
