import { tr } from '../../core/i18n';
import type { CheckKind, OutputFormat } from '../../core/model';
import { anyExists, firstScript, infraNeeds, scriptsOf, toolCheck, type CheckDraft, type Ecosystem } from './shared';

/** Composer script names per kind, most specific first. */
const SCRIPT_KINDS: readonly { readonly kind: CheckKind; readonly names: readonly string[] }[] = [
  { kind: 'typecheck', names: ['phpstan', 'analyse', 'analyze', 'stan', 'psalm', 'static-analysis'] },
  { kind: 'lint', names: ['lint', 'cs', 'phpcs', 'cs:check', 'check-style'] },
  { kind: 'test', names: ['test', 'tests', 'phpunit', 'pest'] },
];

/** Tools installed by Composer, used when the project defines no script for that kind. */
const VENDOR_TOOLS: readonly {
  readonly kind: CheckKind;
  readonly bin: string;
  readonly args: readonly string[];
  readonly format: OutputFormat;
  readonly configs?: readonly string[];
}[] = [
  { kind: 'typecheck', bin: 'phpstan', args: ['analyse', '--no-progress', '--error-format=raw'], format: 'gnu' },
  { kind: 'lint', bin: 'phpcs', args: ['--report=emacs'], format: 'gnu' },
  { kind: 'test', bin: 'phpunit', args: [], format: 'plain', configs: ['phpunit.xml', 'phpunit.xml.dist'] },
  { kind: 'test', bin: 'pest', args: [], format: 'plain' },
];

/**
 * Composer scripts, or PHPStan / PHP_CodeSniffer / PHPUnit / Pest from vendor/bin. PHP checks load the
 * project's autoloader and configuration, so all of them count as running repository code.
 */
export const phpChecks: Ecosystem = async ({ probe }) => {
  const manifest = await probe.readText('composer.json');
  if (manifest === undefined) {
    return [];
  }
  const scripts = scriptsOf(manifest);
  const dependencyWarning = (await probe.exists('vendor'))
    ? []
    : [tr('vendor is missing: Composer dependencies are not installed, so this check will likely fail. Probato PR never installs dependencies.')];

  const drafts: CheckDraft[] = [];
  const taken = new Set<CheckKind>();
  for (const { kind, names } of SCRIPT_KINDS) {
    const name = firstScript(scripts, names);
    if (name === undefined) {
      continue;
    }
    taken.add(kind);
    const body = JSON.stringify(scripts[name]);
    drafts.push(
      toolCheck({
        id: `composer:${name}`,
        kind,
        label: `composer run-script ${name}`,
        command: { executable: 'composer', args: ['run-script', name, '--no-interaction'] },
        rationale: tr('Composer script "{0}" ({1}).', name, kind),
        warnings: [tr('Executes repository code: "{0}": {1}', name, body.slice(0, 300)), ...dependencyWarning],
        requires: infraNeeds(body),
        outputFormat: 'plain',
        runsRepositoryCode: true,
        scriptBody: body,
      }),
    );
  }

  for (const tool of VENDOR_TOOLS) {
    if (taken.has(tool.kind) || !(await probe.exists(`vendor/bin/${tool.bin}`))) {
      continue;
    }
    if (tool.configs && !(await anyExists(probe, tool.configs))) {
      continue;
    }
    taken.add(tool.kind);
    drafts.push(
      toolCheck({
        id: `php:${tool.bin}`,
        kind: tool.kind,
        label: ['php', `vendor/bin/${tool.bin}`, ...tool.args].join(' '),
        command: { executable: 'php', args: [`vendor/bin/${tool.bin}`, ...tool.args] },
        rationale: tr('{0} is installed in vendor/bin.', tool.bin),
        warnings: [tr('Loads the project autoloader and configuration (repository code).')],
        outputFormat: tool.format,
        runsRepositoryCode: true,
      }),
    );
  }
  return drafts;
};
