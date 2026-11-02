import { stableId } from './ids';
import { render, renderEnglish, type Message } from './i18n';
import type { ReviewFinding, SourceLocation, StaticEvidence } from './model';

/**
 * Builds a finding together with the static evidence that backs it. Text fields are messages rendered in the
 * active locale; the id is derived from the English title so it does not change when the language does.
 */
export function staticFinding(input: {
  readonly analyzerId: string;
  readonly ruleId: string;
  readonly severity: ReviewFinding['severity'];
  readonly verification: 'evidenced' | 'suspected';
  readonly verificationNote: Message;
  readonly title: Message;
  readonly description: Message;
  readonly location: SourceLocation;
  readonly evidenceDescription: Message;
  readonly evidenceLocations?: readonly SourceLocation[];
  readonly excerpt?: string;
  readonly suggestedFix?: Message;
}): { finding: ReviewFinding; evidence: StaticEvidence } {
  const id = stableId(input.ruleId, input.location.file, input.location.startLine, renderEnglish(input.title));
  const evidence: StaticEvidence = {
    kind: 'static-analysis',
    id: `ev-${id}`,
    analyzerId: input.analyzerId,
    description: render(input.evidenceDescription),
    locations: input.evidenceLocations ?? [input.location],
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
  };
  const finding: ReviewFinding = {
    id,
    ruleId: input.ruleId,
    severity: input.severity,
    verification: input.verification,
    verificationNote: render(input.verificationNote),
    origin: 'analyzer',
    title: render(input.title),
    description: render(input.description),
    location: input.location,
    evidence: [{ evidenceId: evidence.id, summary: render(input.evidenceDescription) }],
    ...(input.suggestedFix !== undefined ? { suggestedFix: render(input.suggestedFix) } : {}),
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
