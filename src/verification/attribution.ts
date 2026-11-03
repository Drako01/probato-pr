import type { Attribution, CommandEvidence } from '../core/model';
import { tr } from '../core/i18n';
import { fingerprint, type ToolDiagnostic } from './diagnostics-parser';

export interface AttributionResult {
  readonly attribution: Attribution;
  readonly note: string;
  /** Head diagnostics absent from the base run (only when both runs produced parseable diagnostics). */
  readonly introducedDiagnostics: readonly ToolDiagnostic[];
  readonly preExistingDiagnostics: readonly ToolDiagnostic[];
}

const failed = (e: CommandEvidence): boolean => e.outcome === 'failed';

/**
 * Attributes a check result to the change by comparing head and base runs. Never attributes a
 * failure to the change without a comparable passing (or less failing) baseline.
 */
export function attribute(
  head: CommandEvidence,
  base: CommandEvidence | undefined,
  headDiagnostics: readonly ToolDiagnostic[],
  baseDiagnostics: readonly ToolDiagnostic[],
): AttributionResult {
  const none = { introducedDiagnostics: [], preExistingDiagnostics: [] };
  if (head.outcome === 'passed') {
    if (base && failed(base)) {
      return { attribution: 'fixed', note: tr('Fails on the base revision and passes with this change.'), ...none };
    }
    return { attribution: 'unknown', note: tr('Passed with this change.'), ...none };
  }
  if (head.outcome !== 'failed') {
    return { attribution: 'inconclusive', note: tr('The head run did not complete ({0}); nothing can be concluded.', head.outcome), ...none };
  }
  if (!base) {
    return {
      attribution: 'inconclusive',
      note: tr('Failed with this change; no baseline run, so the failure may already exist on the base revision.'),
      ...none,
    };
  }
  if (head.outputTruncated || base.outputTruncated) {
    return { attribution: 'inconclusive', note: tr('The failures could not be compared completely; attribution is inconclusive.'), ...none };
  }
  if (base.outcome === 'passed') {
    return {
      attribution: 'introduced',
      note: tr('Passes on the base revision and fails with this change.'),
      introducedDiagnostics: headDiagnostics,
      preExistingDiagnostics: [],
    };
  }
  if (base.outcome !== 'failed') {
    return { attribution: 'inconclusive', note: tr('The baseline run did not complete ({0}); the failure cannot be attributed.', base.outcome), ...none };
  }
  // A failed baseline with no parseable errors may be a tool/configuration failure. Its empty
  // diagnostic set does not prove that head errors are new. Truncated logs are also incomparable.
  if (headDiagnostics.length === 0 || baseDiagnostics.length === 0) {
    return { attribution: 'inconclusive', note: tr('The failures could not be compared completely; attribution is inconclusive.'), ...none };
  }
  // Compare occurrence counts as well as identities: one old error cannot account for two errors.
  {
    const remaining = new Map<string, number>();
    for (const diagnostic of baseDiagnostics) {
      const key = fingerprint(diagnostic);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const introduced: ToolDiagnostic[] = [];
    const preExisting: ToolDiagnostic[] = [];
    for (const diagnostic of headDiagnostics) {
      const key = fingerprint(diagnostic);
      const available = remaining.get(key) ?? 0;
      if (available > 0) {
        preExisting.push(diagnostic);
        remaining.set(key, available - 1);
      } else {
        introduced.push(diagnostic);
      }
    }
    if (introduced.length > 0) {
      return {
        attribution: 'introduced',
        note: tr('Fails on both revisions; {0} error(s) are new with this change and {1} already existed.', introduced.length, preExisting.length),
        introducedDiagnostics: introduced,
        preExistingDiagnostics: preExisting,
      };
    }
    return {
      attribution: 'pre-existing',
      note: tr('Fails on both revisions with the same {0} error(s); not caused by this change.', preExisting.length),
      introducedDiagnostics: [],
      preExistingDiagnostics: preExisting,
    };
  }
}
