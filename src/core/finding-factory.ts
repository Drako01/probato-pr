import { stableId } from './ids';
import type { ReviewFinding, SourceLocation, StaticEvidence } from './model';

/** Builds a finding together with the static evidence that backs it, keeping ids stable across runs. */
export function staticFinding(input: {
  readonly analyzerId: string;
  readonly ruleId: string;
  readonly severity: ReviewFinding['severity'];
  readonly verification: 'evidenced' | 'suspected';
  readonly verificationNote: string;
  readonly title: string;
  readonly description: string;
  readonly location: SourceLocation;
  readonly evidenceDescription: string;
  readonly evidenceLocations?: readonly SourceLocation[];
  readonly excerpt?: string;
  readonly suggestedFix?: string;
}): { finding: ReviewFinding; evidence: StaticEvidence } {
  const id = stableId(input.ruleId, input.location.file, input.location.startLine, input.title);
  const evidence: StaticEvidence = {
    kind: 'static-analysis',
    id: `ev-${id}`,
    analyzerId: input.analyzerId,
    description: input.evidenceDescription,
    locations: input.evidenceLocations ?? [input.location],
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
  };
  const finding: ReviewFinding = {
    id,
    ruleId: input.ruleId,
    severity: input.severity,
    verification: input.verification,
    verificationNote: input.verificationNote,
    origin: 'analyzer',
    title: input.title,
    description: input.description,
    location: input.location,
    evidence: [{ evidenceId: evidence.id, summary: input.evidenceDescription }],
    ...(input.suggestedFix !== undefined ? { suggestedFix: input.suggestedFix } : {}),
  };
  return { finding, evidence };
}

export class OutputCollector {
  readonly findings: ReviewFinding[] = [];
  readonly evidence: StaticEvidence[] = [];
  readonly limitations: string[] = [];

  add(entry: { finding: ReviewFinding; evidence: StaticEvidence }): void {
    this.findings.push(entry.finding);
    this.evidence.push(entry.evidence);
  }
}
