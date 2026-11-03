import type { Analyzer, WorkspaceIndex } from './analyzer';
import { tr } from './i18n';
import { uniqueId } from './ids';
import {
  SEVERITIES,
  VERIFICATION_STATUSES,
  type AnalyzerRun,
  type ChangeSet,
  type Evidence,
  type ReviewFinding,
  type ReviewResult,
} from './model';
import { assessRisk } from './risk';
import { sanitizeText } from './sanitize';

export type ProgressReporter = (message: string) => void;

const severityRank = (f: ReviewFinding): number => SEVERITIES.indexOf(f.severity);
const verificationRank = (f: ReviewFinding): number => VERIFICATION_STATUSES.indexOf(f.verification);

export function sortFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a) - severityRank(b) ||
      verificationRank(a) - verificationRank(b) ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.startLine - b.location.startLine,
  );
}

/** Merges findings with the same id (same rule, location and title), keeping all their evidence. */
export function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const byId = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (!existing) {
      byId.set(finding.id, finding);
      continue;
    }
    const known = new Set(existing.evidence.map((e) => e.evidenceId));
    byId.set(finding.id, { ...existing, evidence: [...existing.evidence, ...finding.evidence.filter((e) => !known.has(e.evidenceId))] });
  }
  return [...byId.values()];
}

/** Recomputes derived data (ordering, risk) after findings, checks or evidence change. */
export function finalizeResult(result: Omit<ReviewResult, 'risk'>): ReviewResult {
  result = sanitizeText(result);
  const findings = sortFindings(dedupeFindings(result.findings));
  return {
    ...result,
    findings,
    risk: assessRisk({ findings, checks: result.checks, analyzerRuns: result.analyzerRuns, skipped: result.skipped, scope: result.scope }),
  };
}

/** Runs the deterministic analyzers over a change set. Read-only: never modifies files. */
export class ReviewEngine {
  constructor(
    private readonly analyzers: readonly Analyzer[],
    private readonly toolVersion: string,
  ) {}

  async review(changes: ChangeSet, workspace: WorkspaceIndex, options: { signal?: AbortSignal; progress?: ProgressReporter } = {}): Promise<ReviewResult> {
    const findings: ReviewFinding[] = [];
    const evidence: Evidence[] = [];
    const runs: AnalyzerRun[] = [];

    for (const analyzer of this.analyzers) {
      if (options.signal?.aborted) {
        runs.push({ analyzerId: analyzer.id, status: 'skipped', detail: tr('Review cancelled.') });
        continue;
      }
      if (!analyzer.appliesTo(changes)) {
        runs.push({ analyzerId: analyzer.id, status: 'skipped', detail: tr('No changed files in scope.') });
        continue;
      }
      options.progress?.(analyzer.description);
      try {
        const output = await analyzer.analyze({ changes, workspace, ...(options.signal ? { signal: options.signal } : {}) });
        findings.push(...output.findings);
        evidence.push(...output.evidence);
        const partial = output.limitations ?? [];
        runs.push({ analyzerId: analyzer.id, status: 'ran', ...(partial.length > 0 ? { detail: partial.join(' ') } : {}) });
      } catch (error) {
        // Recorded and surfaced as a limitation; one analyzer failing must not hide the others' results.
        runs.push({ analyzerId: analyzer.id, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }

    const stats = changes.files.reduce(
      (acc, f) => ({ ...acc, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { filesChanged: changes.files.length, filesSkipped: changes.skipped.length, additions: 0, deletions: 0 },
    );

    return finalizeResult({
      id: uniqueId(),
      createdAt: new Date().toISOString(),
      toolVersion: this.toolVersion,
      scope: changes.scope,
      repository: changes.repository,
      stats,
      changedFiles: changes.files.map((f) => f.path),
      skipped: changes.skipped,
      findings,
      evidence,
      checks: [],
      analyzerRuns: runs,
      aiRuns: [],
    });
  }
}
