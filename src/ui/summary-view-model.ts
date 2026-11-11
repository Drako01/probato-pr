import * as vscode from 'vscode';
import { mutationView } from './mutation-view-model';
import { explainFinding } from '../core/finding-explanation';
import type { HistoryEntry } from '../infrastructure/history-store';
import { comparisonView } from './review-comparison-view-model';
import { SEVERITIES, VERIFICATION_STATUSES } from '../core/model';
import type { ReviewSession } from '../extension/review-session';
import { attributionLabel, checkResultLabel, checkStatusLabel, reviewStatsLabel, reviewSubtitle, riskLabel, severityLabel, verificationHint, verificationLabel } from './presentation';
import type { SummaryLabels, SummaryState, SummaryStep } from './summary-protocol';

/** The three workflow steps with localized text and their action; shared by the Overview tree and the summary panel. */
export function workflowSteps(session: ReviewSession): SummaryStep[] {
  const flow = session.workflow();
  const review = session.current;
  const plan = session.plan;
  const checks = review?.risk.counts.checks;

  const reviewDetail = review
    ? vscode.l10n.t('{0} · {1} file(s) changed', review.scope.label, review.stats.filesChanged)
    : vscode.l10n.t('Analyze your Git changes locally. No account or AI key needed.');

  let verifyDetail: string;
  switch (flow.verify) {
    case 'done':
      verifyDetail = vscode.l10n.t('{0} passed · {1} failed', checks?.passed ?? 0, checks?.failed ?? 0);
      break;
    case 'unavailable':
      verifyDetail =
        flow.verifyBlocker === 'remote-only'
          ? vscode.l10n.t('Needs the pull request checked out locally')
          : vscode.l10n.t('No checks detected (package.json scripts, tsconfig.json or go.mod)');
      break;
    case 'current':
    case 'todo':
      verifyDetail =
        plan.length > 0
          ? vscode.l10n.t('{0} check(s) detected. Run them to turn suspicions into proof.', plan.length)
          : vscode.l10n.t('Run your project checks to turn suspicions into proof.');
  }

  return [
    {
      id: 'review',
      state: flow.review,
      title: vscode.l10n.t('Review'),
      detail: reviewDetail,
      ...(flow.review === 'current' ? { action: { command: 'reviewCurrentChanges' as const, label: vscode.l10n.t('Review Current Changes') } } : {}),
    },
    {
      id: 'verify',
      state: flow.verify,
      title: vscode.l10n.t('Verify'),
      detail: verifyDetail,
      ...(flow.verify === 'current' || flow.verify === 'done'
        ? { action: { command: 'verify' as const, label: flow.verify === 'done' ? vscode.l10n.t('Run Again') : vscode.l10n.t('Run Checks') } }
        : {}),
    },
    {
      id: 'share',
      state: flow.share,
      title: vscode.l10n.t('Deliver'),
      detail: vscode.l10n.t('Create your pull request, share selected findings, follow CI and merge when GitHub permits it.'),
      ...(flow.review === 'done' ? { action: { command: 'publishPullRequest' as const, label: vscode.l10n.t('Create or Update Pull Request') } } : {}),
    },
  ];
}

function labels(): SummaryLabels {
  return {
    noReview: vscode.l10n.t('No review yet'),
    noReviewHint: vscode.l10n.t('Review your Git changes, verify them with your own project checks, then share the evidence.'),
    reviewCurrent: vscode.l10n.t('Review Current Changes'),
    reviewBranch: vscode.l10n.t('Review Branch'),
    riskTitle: vscode.l10n.t('Review risk'),
    whyRisk: vscode.l10n.t('Why this risk'),
    limitations: vscode.l10n.t('Limitations'),
    findings: vscode.l10n.t('Findings'),
    noFindings: vscode.l10n.t('No findings. Verify to back this with executed checks.'),
    all: vscode.l10n.t('All'),
    searchFindings: vscode.l10n.t('Filter by title, file or rule'),
    showing: vscode.l10n.t('Showing'),
    clearFilters: vscode.l10n.t('Clear filters'),
    noMatches: vscode.l10n.t('No findings match the current filters.'),
    verificationFilter: vscode.l10n.t('Verification'),
    sections: vscode.l10n.t('Sections'),
    groupBySeverity: vscode.l10n.t('By severity'),
    groupByFile: vscode.l10n.t('By file'),
    whyStatus: vscode.l10n.t('Why this status'),
    suggestedFix: vscode.l10n.t('Suggested fix'),
    open: vscode.l10n.t('Open'),
    dismiss: vscode.l10n.t('Dismiss'),
    restoreDismissed: vscode.l10n.t('Restore dismissed'),
    checks: vscode.l10n.t('Checks'),
    noChecks: vscode.l10n.t('No checks executed yet.'),
    evidence: vscode.l10n.t('Evidence'),
    markdown: vscode.l10n.t('Markdown for the PR description'),
    cancel: vscode.l10n.t('Cancel'),
    reviewAgain: vscode.l10n.t('Review again'),
    staged: vscode.l10n.t('Staged Changes'),
    commit: vscode.l10n.t('Commit'),
    pullRequest: vscode.l10n.t('Pull Request'),
    statusLegend: vscode.l10n.t('Only executed checks count as proof.'),
    aiTitle: vscode.l10n.t('AI reviewer'),
    aiConnectHint: vscode.l10n.t('Add your own AI: GitHub Copilot, Claude, OpenAI or a local model. It reviews the change, writes the pull request summary, and you confirm the files every time.'),
    aiConnect: vscode.l10n.t('Connect Your AI'),
    aiReadyHint: vscode.l10n.t('Ask the AI for a second opinion and a pull request summary. Its findings stay suspected until a check proves them.'),
    aiRun: vscode.l10n.t('Run AI Review'),
    aiRunAgain: vscode.l10n.t('Run Again'),
    aiWhereToLook: vscode.l10n.t('Where to look first'),
    aiChange: vscode.l10n.t('Change AI'),
    copyDescription: vscode.l10n.t('Copy PR Description'),
    exportReport: vscode.l10n.t('Export Report'),
    localGit: vscode.l10n.t('Local Git actions'),
    delivery: vscode.l10n.t('GitHub delivery'),
    deliveryHint: vscode.l10n.t('Prepare commits, publish your PR, collaborate, follow CI and merge from here.'),
    publishPullRequest: vscode.l10n.t('Create or Update Pull Request'),
    publishReview: vscode.l10n.t('Publish Selected Findings'),
    publishAnalysis: vscode.l10n.t('Publish Full Analysis to GitHub'),
    publishAnalysisHint: vscode.l10n.t('Posts the whole report as one comment you can edit first. Publishing again updates it instead of duplicating it.'),
    deliveryPrepare: vscode.l10n.t('Prepare'),
    deliveryShare: vscode.l10n.t('Share the analysis'),
    deliveryFollow: vscode.l10n.t('Follow and merge'),
    pullRequestStatus: vscode.l10n.t('Pull Request and CI Status'),
    mergePullRequest: vscode.l10n.t('Merge Pull Request'),
    importSarif: vscode.l10n.t('Import SARIF evidence'),
    findingExplanation: vscode.l10n.t('Finding explanation'),
    reportedObservation: vscode.l10n.t('Reported observation'),
    linkedEvidence: vscode.l10n.t('Linked evidence'),
    linkedChecks: vscode.l10n.t('Explicitly linked checks'),
    missingProof: vscode.l10n.t('Proof still missing'),
    noLinkedChecks: vscode.l10n.t('No executed check is explicitly linked to this finding.'),
    comparison: vscode.l10n.t('Compare reviews'),
    chooseComparison: vscode.l10n.t('Choose a previous review'),
    clearComparison: vscode.l10n.t('Clear comparison'),
    comparisonEligibility: vscode.l10n.t('Only reviews with the same repository, scope, branch and base commit can be compared. Historical evidence is never restored as current.'),
    newFindings: vscode.l10n.t('Newly observed'),
    persistingFindings: vscode.l10n.t('Still observed'),
    noLongerObserved: vscode.l10n.t('No longer observed (resolution unproven)'),
    analysisDuration: vscode.l10n.t('Measured analysis duration'),
    reproducibilityLimitations: vscode.l10n.t('Reproducibility limitations'),
    mutationMetricHelp: vscode.l10n.t('Stryker Mutation Score counts killed and timed-out mutants as detected. The killed-only metric excludes timeouts; incomplete runs do not establish a regression.'), mutationTitle: vscode.l10n.t('Mutation testing and differential gate'), mutationRun: vscode.l10n.t('Run mutation testing (optional)'),
    mutationOptional: vscode.l10n.t('Mutation testing is optional. You approve the impacted files and execution limits before Stryker runs.'),
    mutationExecution: vscode.l10n.t('Execution'), mutationVerification: vscode.l10n.t('Verification result'), mutationBaseline: vscode.l10n.t('Baseline comparability'),
    mutationQuality: vscode.l10n.t('Quality trend'), mutationGate: vscode.l10n.t('Quality gate'), mutationScore: vscode.l10n.t('Stryker Mutation Score'),
    mutationKilledOnly: vscode.l10n.t('Killed-only score (separate metric)'), mutationDelta: vscode.l10n.t('Change in percentage points'),
    mutationRawStatus: vscode.l10n.t('Original Stryker status'), mutationAttribution: vscode.l10n.t('Attribution'), mutationMutants: vscode.l10n.t('Mutants'), mutationReportHash: vscode.l10n.t('Report SHA-256'),
  };
}

/** Everything the summary panel renders. Repository-derived text is passed as data and rendered as text, never markup. */
export function summaryState(session: ReviewSession, aiProvider: string | undefined, candidates: readonly HistoryEntry[] = []): SummaryState {
  const review = session.current;
  const busy = session.busyLabel;
  const base = { labels: labels(), ...(busy ? { busy } : {}), comparisonOptions: candidates.map((candidate) => ({ id: candidate.id, label: `${candidate.scope} · ${candidate.createdAt}` })), ...(session.comparison ? { comparison: comparisonView(session.comparison) } : {}) };
  if (!review) {
    return base;
  }
  const { risk } = review;
  const visible = session.visibleFindings();
  return {
    ...base,
    review: {
      title: review.repository.name,
      subtitle: reviewSubtitle(review),
      stats: reviewStatsLabel(review),
      risk: { level: risk.level, label: riskLabel(risk.level), reasons: risk.reasons, limitations: risk.limitations },
      severityCounts: SEVERITIES.map((severity) => ({ severity, label: severityLabel(severity), count: visible.filter((f) => f.severity === severity).length })),
      verificationCounts: VERIFICATION_STATUSES.map((status) => ({
        status,
        label: verificationLabel(status),
        count: visible.filter((f) => f.verification === status).length,
        hint: verificationHint(status),
      })),
      steps: workflowSteps(session),
      next: session.workflow().next,
      findings: visible.map((f) => {
        const attribution = attributionLabel(f.attribution);
        const explanation = explainFinding(review, f);
        return {
          id: f.id,
          severity: f.severity,
          severityLabel: severityLabel(f.severity),
          verification: f.verification,
          verificationLabel: verificationLabel(f.verification),
          title: f.title,
          description: f.description,
          note: f.verificationNote,
          ...(f.suggestedFix ? { fix: f.suggestedFix } : {}),
          ...(attribution ? { attribution } : {}),
          file: f.location.file,
          line: f.location.startLine,
          ruleId: f.ruleId,
          explanation: {
            observation: explanation.observedChange,
            observationNote: explanation.observationNote,
            evidence: explanation.evidence.map((reference) => ({ id: reference.id, summary: reference.summary, available: reference.available, locations: reference.locations.map((location) => `${location.file}:${location.startLine}`) })),
            checks: explanation.checks.map((check) => ({ label: check.label, statusLabel: [checkStatusLabel(check.status), attributionLabel(check.attribution)].filter(Boolean).join(' · '), note: check.attributionNote })),
            missingProof: explanation.missingProof,
          },
        };
      }),
      dismissed: session.dismissedCount(),
      checks: review.checks.map((c) => ({
        label: c.label,
        status: c.status,
        statusLabel: checkResultLabel(c),
        note: c.attributionNote,
        ...(c.headEvidenceId ? { evidenceId: c.headEvidenceId } : {}),
      })),
      hasLocalCheckout: Boolean(review.repository.root),
      ...(review.mutation ? { mutation: mutationView(review.mutation, review.evidence) } : {}),
      ...(review.performance ? { analysisMs: review.performance.analysisMs } : {}),
      ...(review.reproducibility ? { reproducibilityLimitations: review.reproducibility.filter((check) => check.status === 'inconclusive').flatMap((check) => check.reasons) } : {}),
      ai: { ...(aiProvider ? { provider: aiProvider } : {}), ...(review.aiSummary ? { summary: review.aiSummary } : {}) },
    },
  };
}
