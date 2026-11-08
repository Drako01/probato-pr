import { describe, expect, it } from 'vitest';
import type { ReviewFinding, Severity } from '../../src/core/model';
import { ReviewEngine } from '../../src/core/review-engine';
import { classifyRule, RULE_CATEGORIES } from '../../src/core/rule-taxonomy';
import { renderSarif } from '../../src/reports/sarif';
import { EXPECTED_SECURITY_RULES, SHIPPED_RULES } from './benchmark/rule-catalog';
import { changeSetOf, workspaceOf } from './helpers';

const base = await new ReviewEngine([], 'test').review(changeSetOf([]), workspaceOf({}));
const finding = (ruleId: string, severity: Severity): ReviewFinding => ({ id: `${ruleId}-${severity}`, ruleId, severity, verification: 'evidenced', verificationNote: 'n', origin: 'analyzer', title: 't', description: 'd', location: { file: 'a.ts', startLine: 1 }, evidence: [] });

interface SarifRule { id: string; defaultConfiguration: { level: string }; properties: Record<string, unknown> & { tags: string[] } }
const rulesOf = (findings: ReviewFinding[]): SarifRule[] => (JSON.parse(renderSarif({ ...base, findings })) as { runs: { tool: { driver: { rules: SarifRule[] } } }[] }).runs[0]?.tool.driver.rules ?? [];

const SECURITY = EXPECTED_SECURITY_RULES;

describe('SARIF rule taxonomy', () => {
  it('classifies every shipped rule into a known category, with security reserved for security rules', () => {
    for (const id of SHIPPED_RULES) {
      const { category, cwe } = classifyRule(id);
      expect(RULE_CATEGORIES).toContain(category);
      expect(category === 'security', id).toBe(SECURITY.has(id));
      if (category !== 'security') expect(cwe).toEqual([]);
    }
  });

  it('never classifies unknown, external, AI or prototype-like rule IDs as security', () => {
    for (const id of ['external/security/sql-injection', 'ai/review', 'unknown/rule', 'constructor/x', '__proto__/x', '', 'secrets']) {
      const category = classifyRule(id).category;
      if (id === 'secrets') expect(category).toBe('security');
      else expect(category).not.toBe('security');
    }
  });

  it('emits security-severity only for security rules and problem.severity for every other rule', () => {
    const rules = rulesOf(SHIPPED_RULES.map((id) => finding(id, 'high')));
    expect(rules).toHaveLength(SHIPPED_RULES.length);
    for (const rule of rules) {
      if (SECURITY.has(rule.id)) {
        expect(rule.properties['security-severity']).toBe('8.0');
        expect(rule.properties['problem.severity']).toBeUndefined();
        expect(rule.properties.tags).toContain('security');
      } else {
        expect(rule.properties['security-severity']).toBeUndefined();
        expect(rule.properties['problem.severity']).toBe('error');
        expect(rule.properties.tags).not.toContain('security');
      }
      expect(rule.properties.precision).toBeUndefined();
    }
  });

  it('uses the most severe finding of a rule for its default configuration, independent of order', () => {
    const forward = rulesOf([finding('tests/skipped', 'low'), finding('tests/skipped', 'critical')]);
    const backward = rulesOf([finding('tests/skipped', 'critical'), finding('tests/skipped', 'low')]);
    for (const rules of [forward, backward]) {
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ defaultConfiguration: { level: 'error' }, properties: { 'problem.severity': 'error' } });
    }
    expect(rulesOf([finding('tests/skipped', 'low')])[0]?.properties['problem.severity']).toBe('recommendation');
  });

  it('tags well-established security weaknesses with CWE identifiers', () => {
    expect(rulesOf([finding('secrets/sensitive-file-added', 'critical')])[0]?.properties).toMatchObject({ 'security-severity': '9.5', tags: expect.arrayContaining(['external/cwe/cwe-798']) as unknown });
  });
});
