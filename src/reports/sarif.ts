import { pathToFileURL } from 'node:url';
import type { ReviewFinding, ReviewResult, Severity } from '../core/model';

// SARIF 2.1.0 (OASIS). Consumed by GitHub code scanning, VS Code SARIF Viewer and most CI tools.

type SarifLevel = 'error' | 'warning' | 'note';

const LEVEL: Readonly<Record<Severity, SarifLevel>> = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };
/** GitHub code scanning security-severity scale (0-10). */
const SECURITY_SEVERITY: Readonly<Record<Severity, string>> = { critical: '9.5', high: '8.0', medium: '5.5', low: '2.0' };

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
  const rules = new Map<string, { index: number; sample: ReviewFinding }>();
  for (const finding of result.findings) {
    if (!rules.has(finding.ruleId)) {
      rules.set(finding.ruleId, { index: rules.size, sample: finding });
    }
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
            rules: [...rules.entries()].map(([id, { sample }]) => ({
              id,
              name: ruleName(id),
              shortDescription: { text: id },
              defaultConfiguration: { level: LEVEL[sample.severity] },
              properties: { tags: [id.split('/')[0] ?? 'general'], 'security-severity': SECURITY_SEVERITY[sample.severity] },
            })),
          },
        },
        ...(root ? { originalUriBaseIds: { SRCROOT: { uri: root } } } : {}),
        invocations: [{ executionSuccessful: !result.analyzerRuns.some((r) => r.status === 'failed'), endTimeUtc: result.createdAt }],
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: rules.get(f.ruleId)?.index ?? 0,
          level: LEVEL[f.severity],
          message: { text: `${f.title}\n\n${f.description}\n\nVerification: ${f.verification} — ${f.verificationNote}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodeUri(f.location.file), ...(root ? { uriBaseId: 'SRCROOT' } : {}) },
                region: { startLine: Math.max(1, f.location.startLine), ...(f.location.endLine ? { endLine: f.location.endLine } : {}) },
              },
            },
          ],
          partialFingerprints: { 'probatoFindingId/v1': f.id },
          ...(f.suggestedFix ? { fixes: [{ description: { text: f.suggestedFix } }] } : {}),
          properties: {
            severity: f.severity,
            verification: f.verification,
            attribution: f.attribution ?? 'unknown',
            origin: f.origin,
            evidenceCount: f.evidence.length,
          },
        })),
        properties: {
          reviewRisk: result.risk.level,
          scope: result.scope.label,
          checks: result.checks.map((c) => ({ command: c.commandLine, status: c.status, attribution: c.attribution })),
        },
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
