import { tr } from '../../core/i18n';
import type { CheckKind, OutputFormat } from '../../core/model';
import { toolCheck, type Ecosystem } from './shared';

const CARGO_CHECKS: readonly { readonly kind: CheckKind; readonly args: readonly string[]; readonly format: OutputFormat }[] = [
  { kind: 'typecheck', args: ['check', '--all-targets', '--message-format=short'], format: 'gnu' },
  { kind: 'lint', args: ['clippy', '--all-targets', '--message-format=short'], format: 'gnu' },
  { kind: 'test', args: ['test'], format: 'plain' },
];

/** cargo check / clippy / test. Build scripts and procedural macros are repository code that runs on every build. */
export const rustChecks: Ecosystem = async ({ probe }) => {
  if (!(await probe.exists('Cargo.toml'))) {
    return [];
  }
  const warnings = [tr('Build scripts (build.rs) and procedural macros run during the build.'), tr('May download crates if they are not cached (network).')];
  return CARGO_CHECKS.map(({ kind, args, format }) => {
    const subcommand = args[0] ?? '';
    return toolCheck({
      id: `cargo:${subcommand}`,
      kind,
      label: ['cargo', ...args].join(' '),
      command: { executable: 'cargo', args: [...args] },
      rationale: tr('Rust package detected (Cargo.toml); standard cargo {0}.', subcommand),
      warnings,
      requires: subcommand === 'clippy' ? [tr('the clippy component (rustup component add clippy)')] : [],
      outputFormat: format,
      runsRepositoryCode: true,
    });
  });
};
