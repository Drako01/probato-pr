import { tr } from './i18n';
import type { CheckResult, ReviewFinding, ReviewResult, SourceLocation } from './model';

export interface FindingExplanation {
  readonly observedChange: string;
  readonly observationNote: string;
  readonly evidence: readonly {
    readonly id: string;
    readonly summary: string;
    readonly kind: 'static-analysis' | 'command-run' | 'unavailable';
    readonly locations: readonly SourceLocation[];
    readonly available: boolean;
  }[];
  readonly checks: readonly Pick<CheckResult, 'checkId' | 'label' | 'status' | 'attribution' | 'attributionNote'>[];
  readonly missingProof: readonly string[];
}

/** Explains explicit relationships only. Same file/line, successful checks and AI prose never create proof links. */
export function explainFinding(review: ReviewResult, finding: ReviewFinding): FindingExplanation {
  const references = new Set(finding.evidence.map((reference) => reference.evidenceId));
  const evidence = finding.evidence.map((reference) => {
    const source = review.evidence.find((candidate) => candidate.id === reference.evidenceId);
    return {
      id: reference.evidenceId,
      summary: reference.summary,
      kind: source?.kind ?? 'unavailable' as const,
      locations: source?.kind === 'static-analysis' ? source.locations : [],
      available: source !== undefined,
    };
  });
  const checks = review.checks.filter((check) => (check.headEvidenceId && references.has(check.headEvidenceId)) || (check.baseEvidenceId && references.has(check.baseEvidenceId)))
    .map(({ checkId, label, status, attribution, attributionNote }) => ({ checkId, label, status, attribution, attributionNote }));
  const missingProof: string[] = [];
  if (evidence.length === 0 || evidence.some((reference) => !reference.available)) missingProof.push(tr('Some referenced evidence is unavailable. The finding cannot be independently checked from this review alone.'));
  if (finding.origin === 'ai' || finding.verification === 'suspected') missingProof.push(tr('This is a hypothesis. AI text and heuristic signals do not prove a defect.'));
  if (!checks.length || !evidence.some((reference) => reference.kind === 'command-run')) missingProof.push(tr('No executed check is explicitly linked to this finding.'));
  if (finding.verification !== 'confirmed') missingProof.push(tr('An executed diagnostic has not confirmed this finding.'));
  if (finding.attribution !== 'introduced' && finding.attribution !== 'pre-existing' && finding.attribution !== 'fixed') missingProof.push(tr('A comparable base-versus-head result has not established whether this change caused the finding.'));
  return {
    observedChange: finding.description,
    observationNote: finding.origin === 'ai' || finding.verification === 'suspected'
      ? tr('Reported hypothesis; inspect the linked evidence before treating it as an observed defect.')
      : tr('Reported observation from this review. Static evidence does not by itself prove runtime behavior.'),
    evidence,
    checks,
    missingProof,
  };
}
