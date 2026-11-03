import { parseDocument } from 'yaml';
import { z } from 'zod';
import { tr } from './i18n';
import { severityLabel } from './labels';
import { SEVERITIES, type ReviewResult } from './model';
import { assessRisk } from './risk';

export const MAX_POLICY_BYTES = 65_536;
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9:/_.-]*$/).refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key));
const relativePattern = z.string().min(1).max(240).refine((pattern) => !pattern.startsWith('/') && !pattern.includes('\\') && !pattern.includes(':') && !pattern.split('/').includes('..') && !Array.from(pattern).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const PolicySchema = z.object({
  version: z.literal(1),
  mutation: z.object({ enabled: z.boolean().optional(), failOnDegradation: z.boolean().optional(), minimumScore: z.number().min(0).max(100).optional(), tolerancePoints: z.number().min(0).max(100).optional() }).strict().optional(),
  review: z.object({ severityOverrides: z.record(identifier, z.enum(SEVERITIES)).refine((entries) => Object.keys(entries).length <= 100).optional() }).strict().optional(),
  checks: z.object({ recommendations: z.array(z.object({ paths: z.array(relativePattern).min(1).max(30), checkIds: z.array(identifier).min(1).max(100) }).strict()).max(100).optional() }).strict().optional(),
}).strict();
export type RepositoryPolicy = z.infer<typeof PolicySchema>;

/** Repository policy is declarative: it cannot define commands, credentials, approvals, or suppress findings. */
export function parseRepositoryPolicy(text: string): RepositoryPolicy {
  if (Buffer.byteLength(text, 'utf8') > MAX_POLICY_BYTES) throw new Error(tr('Repository policy exceeds the {0}-byte limit.', MAX_POLICY_BYTES));
  try {
    const document = parseDocument(text, { schema: 'core', customTags: [], uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('yaml');
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    const parsed = PolicySchema.safeParse(value);
    if (!parsed.success) throw new Error('schema');
    return parsed.data;
  } catch {
    throw new Error(tr('Invalid .probato.yml: use version 1 and supported review overrides, check recommendations, or mutation gate policy only.'));
  }
}

/** Every severity adjustment is disclosed. Critical findings and secret findings cannot be downgraded. */
export function applyReviewPolicy(result: ReviewResult, policy: RepositoryPolicy): ReviewResult {
  const notes: string[] = [];
  const findings = result.findings.map((finding) => {
    const severity = policy.review?.severityOverrides?.[finding.ruleId];
    if (!severity || severity === finding.severity) return finding;
    const downgrade = SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(finding.severity);
    if (downgrade && (finding.severity === 'critical' || finding.ruleId.startsWith('secrets/'))) {
      notes.push(tr('Repository policy cannot lower the severity of protected finding {0}.', finding.ruleId));
      return finding;
    }
    notes.push(tr('Repository policy changed {0} severity from {1} to {2}.', finding.ruleId, severityLabel(finding.severity), severityLabel(severity)));
    return { ...finding, severity };
  });
  if (!notes.length) return result;
  const risk = assessRisk({ ...result, findings });
  const policyNotes = [...new Set([...(result.policyNotes ?? []), ...notes])];
  return { ...result, findings, policyNotes, risk: { ...risk, limitations: [...new Set([...risk.limitations, ...policyNotes])] } };
}
