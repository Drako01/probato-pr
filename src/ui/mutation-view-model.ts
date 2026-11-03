import { tr } from '../core/i18n';
import type { Evidence } from '../core/model';
import type { MutationResult } from '../mutation/model';
import { baselineLabel, findingAttributionLabel, gateDecisionLabel, mutationExecutionLabel, mutationStatusLabel, mutationVerificationLabel, qualityTrendLabel } from '../mutation/labels';

export interface MutationView {
  readonly execution: { readonly value: string; readonly label: string };
  readonly verification: { readonly value: string; readonly label: string; readonly reasons: readonly string[] };
  readonly baseline: { readonly value: string; readonly label: string; readonly reasons: readonly string[] };
  readonly quality: { readonly value: string; readonly label: string; readonly deltaPoints?: number; readonly reasons: readonly string[] };
  readonly gate: { readonly value: string; readonly label: string; readonly reasons: readonly string[] };
  readonly runs: readonly {
    readonly revision: 'head' | 'base'; readonly label: string; readonly command: string; readonly reportHash?: string;
    readonly evidenceId?: string; readonly score?: number; readonly killedOnlyScore?: number;
    readonly context: readonly string[];
    readonly counts: readonly { readonly label: string; readonly count: number }[];
  }[];
  readonly mutants: readonly { readonly file: string; readonly line: number; readonly status: string; readonly rawStatus: string; readonly attribution: string; readonly detail: string }[];
  readonly displayed: string;
}

/** Presentation only: lifecycle, verifier result, quality trend and gate remain separate axes. */
export function mutationView(result: MutationResult, evidence: readonly Evidence[]): MutationView {
  const records = result.head?.report?.mutants ?? [];
  return {
    execution: { value: result.execution.status, label: mutationExecutionLabel(result.execution.status) },
    verification: { value: result.verification.status, label: mutationVerificationLabel(result.verification.status), reasons: result.verification.reasons },
    baseline: { value: result.baseline.status, label: baselineLabel(result.baseline.status), reasons: result.baseline.reasons },
    quality: { value: result.quality.trend, label: qualityTrendLabel(result.quality.trend), ...(result.quality.deltaPoints !== undefined ? { deltaPoints: result.quality.deltaPoints } : {}), reasons: result.quality.reasons },
    gate: { value: result.gate.decision, label: gateDecisionLabel(result.gate.decision), reasons: result.gate.reasons },
    runs: [result.base, result.head].flatMap((run) => {
      if (!run) return [];
      const context = run.reproducibility ? [
        tr('Commit: {0}', run.reproducibility.commit),
        tr('Node: {0}; Stryker: {1}; runner: {2}', run.reproducibility.nodeVersion, run.reproducibility.strykerVersion, run.reproducibility.runner),
        tr('Source hash: {0}', run.reproducibility.sourceHash),
        tr('Dependency hash: {0}', run.reproducibility.dependencyHash),
        tr('Conditions hash: {0}', run.reproducibility.conditionsHash),
      ] : [tr('Reproducibility metadata is unavailable.')];
      const recorded = evidence.find((entry) => entry.id === run.id && entry.kind === 'command-run' && entry.outputSha256 === run.outputSha256);
      return [{
        revision: run.revision, label: run.revision === 'base' ? tr('Base revision') : tr('Current revision'), command: run.commandLine,
        ...(run.reportSha256 ? { reportHash: run.reportSha256 } : {}),
        ...(recorded ? { evidenceId: recorded.id } : {}),
        ...(run.report?.metrics.mutationScore !== undefined ? { score: run.report.metrics.mutationScore } : {}),
        ...(run.report?.metrics.killedOnlyScore !== undefined ? { killedOnlyScore: run.report.metrics.killedOnlyScore } : {}),
        context,
        counts: run.report ? Object.entries(run.report.metrics.counts).map(([status, count]) => ({ label: mutationStatusLabel(status as Parameters<typeof mutationStatusLabel>[0]), count })) : [],
      }];
    }),
    mutants: records.slice(0, 200).map((record) => ({ file: record.file, line: record.line, status: mutationStatusLabel(record.status), rawStatus: record.rawStatus, attribution: findingAttributionLabel(record.attribution), detail: record.reason ?? '' })),
    displayed: tr('Showing {0} of {1} mutants. The exported report retains the full result.', Math.min(records.length, 200), records.length),
  };
}
