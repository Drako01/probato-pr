import type { SummaryFinding } from './summary-protocol';

export interface FindingFilter {
  readonly severity: string;
  readonly verification: string;
  readonly query: string;
}

/** A saved selection is only honoured while it still matches something, so a stale value never hides every finding. */
export const activeFilter = (selected: string, available: readonly string[]): string => (available.includes(selected) ? selected : 'all');

/** Severity and verification are exact matches ('all' disables them); the query is a case-insensitive substring of title, file or rule. */
export function filterFindings(findings: readonly SummaryFinding[], filter: FindingFilter): readonly SummaryFinding[] {
  const query = filter.query.trim().toLowerCase();
  return findings.filter((f) =>
    (filter.severity === 'all' || f.severity === filter.severity)
    && (filter.verification === 'all' || f.verification === filter.verification)
    && (query === '' || `${f.title} ${f.file} ${f.ruleId}`.toLowerCase().includes(query)));
}
