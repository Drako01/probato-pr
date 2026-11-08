// Test-side catalog of every rule ID the product emits. Shared by the SARIF taxonomy test and the labeled
// benchmark so both judge the same rule set. Secret rule IDs are derived from the production pattern catalog;
// `rule-catalog.test.ts` fails when an analyzer emits a literal rule ID that is missing here.
import { SECRET_PATTERNS } from '../../../src/core/secrets';

/** Rules emitted by the deterministic analyzers registered in `src/analyzers/index.ts`. */
export const ANALYZER_RULES: readonly string[] = [
  'contracts/export-removed', 'contracts/arity-increased', 'contracts/module-removed', 'contracts/enum-member-removed', 'contracts/property-removed',
  'errors/empty-catch', 'errors/empty-promise-catch', 'errors/type-check-suppressed', 'errors/lint-suppressed',
  'cross-stack/api-property-removed', 'cross-stack/sql-column-reference', 'cross-stack/tenant-predicate-removed',
  'secrets/sensitive-file-added', ...SECRET_PATTERNS.map((pattern) => `secrets/${pattern.id}`),
  'dependencies/install-script', 'dependencies/major-upgrade', 'dependencies/removed-but-imported', 'dependencies/go-local-replace',
  'config/ts-strictness-reduced', 'config/workflow-pull-request-target', 'config/workflow-write-all',
  'tests/file-deleted', 'tests/cases-removed', 'tests/focused', 'tests/skipped', 'tests/assertions-removed', 'tests/assertions-reduced',
];

/** Every rule ID that can reach a report: analyzers, the verification linker, SARIF import and AI review. */
export const SHIPPED_RULES: readonly string[] = [...ANALYZER_RULES, 'verification/test', 'external/eslint/no-unused-vars', 'ai/review'];

/**
 * Independent oracle for the taxonomy test: rules that describe a vulnerability or a security control. Written by
 * hand on purpose, so a wrong entry in `src/core/rule-taxonomy.ts` is caught instead of copied.
 */
export const EXPECTED_SECURITY_RULES: ReadonlySet<string> = new Set([
  ...ANALYZER_RULES.filter((id) => id.startsWith('secrets/')),
  'dependencies/install-script', 'config/workflow-pull-request-target', 'config/workflow-write-all', 'cross-stack/tenant-predicate-removed',
]);
