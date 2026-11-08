import { tr } from '../core/i18n';
import { verificationLabel } from '../core/labels';
import { sanitizeText } from '../core/sanitize';
import { pathToFileURL } from 'node:url';
import { SEVERITIES, type ReviewResult, type Severity } from '../core/model';
import { classifyRule } from '../core/rule-taxonomy';

// SARIF 2.1.0 (OASIS). Consumed by GitHub code scanning, VS Code SARIF Viewer and most CI tools.

type SarifLevel = 'error' | 'warning' | 'note';

const LEVEL: Readonly<Record<Severity, SarifLevel>> = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };
/** GitHub code scanning security-severity scale (0-10). Emitted only for rules classified as security. */
const SECURITY_SEVERITY: Readonly<Record<Severity, string>> = { critical: '9.5', high: '8.0', medium: '5.5', low: '2.0' };
/** GitHub code scanning `problem.severity` for quality (non-security) rules. */
const PROBLEM_SEVERITY: Readonly<Record<Severity, 'error' | 'warning' | 'recommendation'>> = { critical: 'error', high: 'error', medium: 'warning', low: 'recommendation' };

// `precision` is deliberately omitted: it must come from an external benchmark, which does not exist yet.
function ruleProperties(ruleId: string, severity: Severity): Record<string, unknown> {
  const { category, cwe } = classifyRule(ruleId);
  if (category === 'security') {
    return { tags: ['security', category, ...cwe.map((id) => `external/cwe/${id.toLowerCase()}`)], category, 'security-severity': SECURITY_SEVERITY[severity] };
  }
  return { tags: [category, 'quality'], category, 'problem.severity': PROBLEM_SEVERITY[severity] };
}

function encodeUri(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function ruleName(ruleId: string): string {
  return ruleId
    .split(/[/-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export function renderSarif(result: ReviewResult): string {
  result = sanitizeText(result);
  // A rule's default severity is the most severe finding it produced in this run.
  const rules = new Map<string, { index: number; severity: Severity }>();
  for (const finding of result.findings) {
    const known = rules.get(finding.ruleId);
    if (!known) rules.set(finding.ruleId, { index: rules.size, severity: finding.severity });
    else if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(known.severity)) rules.set(finding.ruleId, { ...known, severity: finding.severity });
  }
  const root = result.repository.root ? pathToFileURL(result.repository.root.endsWith('/') || result.repository.root.endsWith('\\') ? result.repository.root : `${result.repository.root}/`).href : undefined;

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Probato PR',
            organization: 'ArmoTuSitio',
            version: result.toolVersion,
            semanticVersion: result.toolVersion,
            informationUri: 'https://armotusitio.com.ar',
            rules: [...rules.entries()].map(([id, { severity }]) => ({
              id,
              name: ruleName(id),
              shortDescription: { text: id },
              defaultConfiguration: { level: LEVEL[severity] },
              properties: ruleProperties(id, severity),
            })),
          },
        },
        ...(root ? { originalUriBaseIds: { SRCROOT: { uri: root } } } : {}),
        invocations: [{ executionSuccessful: !result.analyzerRuns.some((r) => r.status === 'failed'), endTimeUtc: result.createdAt }],
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: rules.get(f.ruleId)?.index ?? 0,
          level: LEVEL[f.severity],
          message: { text: `${f.title}\n\n${f.description}\n\n${tr('Verification: {0}', verificationLabel(f.verification))} — ${f.verificationNote}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodeUri(f.location.file), ...(root ? { uriBaseId: 'SRCROOT' } : {}) },
                region: { startLine: Math.max(1, f.location.startLine), ...(f.location.endLine ? { endLine: f.location.endLine } : {}) },
              },
            },
          ],
          partialFingerprints: { 'probatoFindingId/v1': f.id },
          properties: {
            severity: f.severity,
            verification: f.verification,
            attribution: f.attribution ?? 'unknown',
            origin: f.origin,
            evidenceCount: f.evidence.length,
            ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}),
          },
        })),
        properties: {
          reviewRisk: result.risk.level,
          ...(result.mutation ? { mutationTesting: result.mutation } : {}),
          ...(result.reproducibility ? { reproducibility: result.reproducibility } : {}),
          ...(result.performance ? { analysisPerformance: result.performance } : {}),
          scope: result.scope.label,
          checks: result.checks.map((c) => ({ command: c.commandLine, status: c.status, attribution: c.attribution })),
        },
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
