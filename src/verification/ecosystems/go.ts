import { tr } from '../../core/i18n';
import type { CheckKind, OutputFormat } from '../../core/model';
import { toolCheck, type Ecosystem } from './shared';

const GO_CHECKS: readonly { readonly kind: CheckKind; readonly sub: string; readonly format: OutputFormat }[] = [
  { kind: 'build', sub: 'build', format: 'go' },
  { kind: 'vet', sub: 'vet', format: 'go' },
  { kind: 'test', sub: 'test', format: 'plain' },
];

/** Standard go build / vet / test for a module. */
export const goChecks: Ecosystem = async ({ probe }) => {
  if (!(await probe.exists('go.mod'))) {
    return [];
  }
  const network = tr('May download modules if they are not cached (network).');
  return GO_CHECKS.map(({ kind, sub, format }) =>
    toolCheck({
      id: `go:${sub}`,
      kind,
      label: `go ${sub} ./...`,
      command: { executable: 'go', args: [sub, './...'] },
      rationale: tr('Go module detected (go.mod); standard go {0}.', sub),
      warnings: sub === 'test' ? [tr('Executes the repository test code.'), network] : [network],
      outputFormat: format,
      runsRepositoryCode: sub === 'test',
    }),
  );
};
