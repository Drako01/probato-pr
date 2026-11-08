// Single source of truth for what kind of problem each rule reports. Pure domain: no VS Code or I/O.
// Only rules listed as `security` describe a vulnerability or a security control; every other rule is a
// quality signal. Unknown rules (external SARIF, AI hypotheses, rules added without a classification)
// are never presented as security issues: they resolve to a non-security category.

export const RULE_CATEGORIES = ['security', 'correctness', 'test-integrity', 'maintainability', 'external', 'ai-hypothesis'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export interface RuleClassification {
  readonly category: RuleCategory;
  /** CWE identifiers, only for security rules whose weakness is well established. */
  readonly cwe: readonly string[];
}

const SECURITY_RULES: Readonly<Record<string, readonly string[]>> = {
  'dependencies/install-script': ['CWE-829'],
  'config/workflow-pull-request-target': ['CWE-829'],
  'config/workflow-write-all': ['CWE-250'],
  'cross-stack/tenant-predicate-removed': ['CWE-639'],
};

const PREFIX_CATEGORY: Readonly<Record<string, RuleCategory>> = {
  secrets: 'security',
  contracts: 'correctness',
  'cross-stack': 'correctness',
  dependencies: 'correctness',
  verification: 'correctness',
  errors: 'correctness',
  config: 'maintainability',
  tests: 'test-integrity',
  external: 'external',
  ai: 'ai-hypothesis',
};

const SECRET_CWE: readonly string[] = ['CWE-798'];

export function classifyRule(ruleId: string): RuleClassification {
  // hasOwn guards against inherited keys such as "constructor" coming from repository-controlled rule IDs
  // (imported SARIF, external tools): an inherited property must never classify a rule as security.
  const exact = Object.hasOwn(SECURITY_RULES, ruleId) ? SECURITY_RULES[ruleId] : undefined;
  if (exact) return { category: 'security', cwe: exact };
  const prefix = ruleId.split('/')[0] ?? '';
  const category = (Object.hasOwn(PREFIX_CATEGORY, prefix) ? PREFIX_CATEGORY[prefix] : undefined) ?? 'external';
  if (category === 'security') return { category, cwe: prefix === 'secrets' ? SECRET_CWE : [] };
  return { category, cwe: [] };
}

export function isSecurityRule(ruleId: string): boolean {
  return classifyRule(ruleId).category === 'security';
}
