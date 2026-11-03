import { z } from 'zod';
import { tr } from '../core/i18n';
import { stableId } from '../core/ids';
import type { ReviewFinding, ReviewResult, Severity, StaticEvidence } from '../core/model';
import { finalizeResult } from '../core/review-engine';
import { redactSecrets } from '../core/secrets';

const Message = z.object({ text: z.string().max(20_000).optional(), markdown: z.string().max(20_000).optional() });
const Result = z.object({
  ruleId: z.string().max(500).optional(), level: z.enum(['none', 'note', 'warning', 'error']).optional(), message: Message,
  locations: z.array(z.object({ physicalLocation: z.object({ artifactLocation: z.object({ uri: z.string().max(2000) }), region: z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1).optional() }).optional() }).optional() })).max(100).optional(),
});
const Schema = z.object({ version: z.literal('2.1.0'), runs: z.array(z.object({ tool: z.object({ driver: z.object({ name: z.string().max(200) }) }), results: z.array(Result).max(10_000).optional() })).max(100) });

/** Imports external diagnostics as evidence only: no external report can assert causal confirmation. */
export function importSarif(text: string, review: ReviewResult): ReviewResult {
  if (text.length > 20_000_000) { throw new Error(tr('The SARIF report exceeds the 20 MB import limit.')); }
  const parsed = Schema.parse(JSON.parse(text));
  const changed = new Set(review.changedFiles);
  const findings: ReviewFinding[] = [];
  const evidence: StaticEvidence[] = [];
  const knownEvidence = new Set(review.evidence.map((entry) => entry.id));
  let ignored = 0;
  for (const run of parsed.runs) {
    for (const result of run.results ?? []) {
      if (result.level === 'none') { continue; }
      const location = result.locations?.[0]?.physicalLocation;
      let file: string;
      try { file = decodeURIComponent(location?.artifactLocation.uri ?? '').replaceAll('\\', '/').replace(/^\.\//, ''); } catch { ignored++; continue; }
      if (!changed.has(file) || file.startsWith('/') || /^[a-z]:/i.test(file) || file.split('/').includes('..')) { ignored++; continue; }
      const message = redactSecrets(result.message.text ?? result.message.markdown ?? tr('External diagnostic'));
      const id = stableId('sarif', run.tool.driver.name, result.ruleId ?? '', file, location?.region?.startLine ?? 1, message);
      const evidenceId = `sarif-${id}`;
      const severity: Severity = result.level === 'error' ? 'high' : result.level === 'note' ? 'low' : 'medium';
      const source = { file, startLine: location?.region?.startLine ?? 1 };
      if (!knownEvidence.has(evidenceId)) {
        evidence.push({ kind: 'static-analysis', id: evidenceId, analyzerId: `sarif-import:${redactSecrets(run.tool.driver.name)}`, description: message, locations: [source] });
        knownEvidence.add(evidenceId);
      }
      findings.push({ id, ruleId: `external/${result.ruleId ?? 'diagnostic'}`, severity, verification: 'evidenced', verificationNote: tr('Imported from an external SARIF report. Its execution and baseline were not verified by Probato PR.'), origin: 'verification', title: message.slice(0, 200), description: message, location: source, evidence: [{ evidenceId, summary: redactSecrets(run.tool.driver.name) }], attribution: 'unknown' });
    }
  }
  return finalizeResult({ ...review, findings: [...review.findings, ...findings], evidence: [...review.evidence, ...evidence], analyzerRuns: [...review.analyzerRuns, { analyzerId: 'sarif-import', status: 'ran', ...(ignored > 0 ? { detail: tr('{0} diagnostic(s) outside the reviewed files or with invalid paths were ignored.', ignored) } : {}) }] });
}
