import type { Attribution, CommandEvidence } from '../core/model';
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
      return { attribution: 'fixed', note: 'Fails on the base revision and passes with this change.', ...none };
    }
    return { attribution: 'unknown', note: 'Passed with this change.', ...none };
  }
  if (head.outcome !== 'failed') {
    return { attribution: 'inconclusive', note: `The head run did not complete (${head.outcome}); nothing can be concluded.`, ...none };
  }
  if (!base) {
    return { attribution: 'inconclusive', note: 'Failed with this change; no baseline run, so the failure may already exist on the base revision.', ...none };
  }
  if (base.outcome === 'passed') {
    return {
      attribution: 'introduced',
      note: 'Passes on the base revision and fails with this change.',
      introducedDiagnostics: headDiagnostics,
      preExistingDiagnostics: [],
    };
  }
  if (base.outcome !== 'failed') {
    return { attribution: 'inconclusive', note: `The baseline run did not complete (${base.outcome}); the failure cannot be attributed.`, ...none };
  }
  // Both failed: diagnostics (if parseable) tell new errors apart from old ones.
  if (headDiagnostics.length > 0 || baseDiagnostics.length > 0) {
    const baseSet = new Set(baseDiagnostics.map(fingerprint));
    const introduced = headDiagnostics.filter((d) => !baseSet.has(fingerprint(d)));
    const preExisting = headDiagnostics.filter((d) => baseSet.has(fingerprint(d)));
    if (introduced.length > 0) {
      return {
        attribution: 'introduced',
        note: `Fails on both revisions; ${introduced.length} error(s) are new with this change and ${preExisting.length} already existed.`,
        introducedDiagnostics: introduced,
        preExistingDiagnostics: preExisting,
      };
    }
    return {
      attribution: 'pre-existing',
      note: `Fails on both revisions with the same ${preExisting.length} error(s); not caused by this change.`,
      introducedDiagnostics: [],
      preExistingDiagnostics: preExisting,
    };
  }
  return {
    attribution: 'pre-existing',
    note: 'Fails on both the base revision and with this change, so the failure is not attributed to it. Individual failures could not be compared; additional failures caused by this change cannot be ruled out.',
    ...none,
  };
}
