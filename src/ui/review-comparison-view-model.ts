import { tr } from '../core/i18n';
import type { ComparisonStatus, ReviewComparison } from '../core/review-comparison';

export interface ComparisonView {
  readonly previousId: string;
  readonly currentId: string;
  readonly comparable: boolean;
  readonly reason?: string;
  readonly counts: Readonly<Record<ComparisonStatus, number>>;
  readonly entries: readonly {
    readonly status: ComparisonStatus;
    readonly label: string;
    readonly title: string;
    readonly file: string;
    readonly line: number;
    readonly note: string;
    readonly currentFindingId?: string;
    readonly passedCheckEvidenceId?: string;
  }[];
}
export function comparisonView(comparison: ReviewComparison): ComparisonView {
  return {
    previousId: comparison.previousId, currentId: comparison.currentId, comparable: comparison.comparable,
    ...(comparison.reason ? { reason: comparison.reason } : {}), counts: comparison.counts,
    entries: comparison.entries.map((entry) => {
      const finding = entry.current ?? entry.previous;
      return {
        status: entry.status,
        label: entry.status === 'new' ? tr('Newly observed') : entry.status === 'persisting' ? tr('Still observed') : tr('No longer observed (resolution unproven)'),
        title: finding?.title ?? '', file: finding?.location.file ?? '', line: finding?.location.startLine ?? 1, note: entry.note,
        ...(entry.current ? { currentFindingId: entry.current.id } : {}),
        ...(entry.passedCheckEvidenceId ? { passedCheckEvidenceId: entry.passedCheckEvidenceId } : {}),
      };
    }),
  };
}
