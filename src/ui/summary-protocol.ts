// Contract between the extension host and the Review Summary webview. The webview imports types only;
// every message it sends is validated here before the host acts on it.
import { z } from 'zod';
import type { AiSummary, CheckStatus, RiskLevel, Severity, VerificationStatus } from '../core/model';
import type { NextAction, StepState } from './workflow';
import type { MutationView } from './mutation-view-model';
import type { ComparisonView } from './review-comparison-view-model';

/** Host commands the webview may trigger. Anything else is rejected. */
export const SUMMARY_COMMANDS = [
  'reviewCurrentChanges',
  'reviewStagedChanges',
  'reviewBranch',
  'reviewCommit',
  'reviewPullRequest',
  'verify',
  'mutationTesting',
  'exportReport',
  'aiReview',
  'cancel',
  'restoreDismissed',
  'openMarkdownReport',
  'copyPullRequestDescription',
  'connectAi',
  'localGit',
  'delivery',
  'publishPullRequest',
  'publishReview',
  'publishAnalysis',
  'pullRequestStatus',
  'mergePullRequest',
  'importSarif',
] as const;
export type SummaryCommand = (typeof SUMMARY_COMMANDS)[number];

/** VS Code command behind each summary command. */
export const SUMMARY_COMMAND_IDS: Readonly<Record<SummaryCommand, string>> = {
  reviewCurrentChanges: 'probatoPR.reviewCurrentChanges',
  reviewStagedChanges: 'probatoPR.reviewStagedChanges',
  reviewBranch: 'probatoPR.reviewBranch',
  reviewCommit: 'probatoPR.reviewCommit',
  reviewPullRequest: 'probatoPR.reviewPullRequest',
  verify: 'probatoPR.verify',
  mutationTesting: 'probatoPR.mutationTesting',
  exportReport: 'probatoPR.exportReport',
  aiReview: 'probatoPR.aiReview',
  cancel: 'probatoPR.cancel',
  restoreDismissed: 'probatoPR.restoreDismissed',
  openMarkdownReport: 'probatoPR.openMarkdownReport',
  copyPullRequestDescription: 'probatoPR.copyPullRequestDescription',
  connectAi: 'probatoPR.connectAi',
  localGit: 'probatoPR.localGit',
  delivery: 'probatoPR.delivery',
  publishPullRequest: 'probatoPR.publishPullRequest',
  publishReview: 'probatoPR.publishReview',
  publishAnalysis: 'probatoPR.publishAnalysis',
  pullRequestStatus: 'probatoPR.pullRequestStatus',
  mergePullRequest: 'probatoPR.mergePullRequest',
  importSarif: 'probatoPR.importSarif',
};

const id = z.string().min(1).max(200);

export const webviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('command'), command: z.enum(SUMMARY_COMMANDS) }),
  z.object({ type: z.literal('openFinding'), id }),
  z.object({ type: z.literal('dismissFinding'), id }),
  z.object({ type: z.literal('openEvidence'), id }),
  z.object({ type: z.literal('compareReview'), id }),
  z.object({ type: z.literal('clearComparison') }),
]);
export type WebviewMessage = z.infer<typeof webviewMessageSchema>;

export interface SummaryStep {
  readonly id: 'review' | 'verify' | 'share';
  readonly state: StepState;
  readonly title: string;
  readonly detail: string;
  readonly action?: { readonly command: SummaryCommand; readonly label: string };
}

export interface SummaryFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly severityLabel: string;
  readonly verification: VerificationStatus;
  readonly verificationLabel: string;
  readonly title: string;
  readonly description: string;
  readonly note: string;
  readonly fix?: string;
  readonly attribution?: string;
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly explanation: {
    readonly observation: string;
    readonly observationNote: string;
    readonly evidence: readonly { readonly id: string; readonly summary: string; readonly available: boolean; readonly locations: readonly string[] }[];
    readonly checks: readonly { readonly label: string; readonly statusLabel: string; readonly note: string }[];
    readonly missingProof: readonly string[];
  };
}

export interface SummaryCheck {
  readonly label: string;
  readonly status: CheckStatus;
  readonly statusLabel: string;
  readonly note: string;
  readonly evidenceId?: string;
}

/** The optional AI reviewer: not connected, connected (ready to run), or its latest walkthrough. */
export interface SummaryAi {
  readonly provider?: string;
  readonly summary?: AiSummary;
}

export interface SummaryReview {
  readonly title: string;
  readonly subtitle: string;
  readonly stats: string;
  readonly risk: { readonly level: RiskLevel; readonly label: string; readonly reasons: readonly string[]; readonly limitations: readonly string[] };
  readonly severityCounts: readonly { readonly severity: Severity; readonly label: string; readonly count: number }[];
  readonly verificationCounts: readonly { readonly status: VerificationStatus; readonly label: string; readonly count: number; readonly hint: string }[];
  readonly steps: readonly SummaryStep[];
  readonly next: NextAction;
  readonly findings: readonly SummaryFinding[];
  readonly dismissed: number;
  readonly checks: readonly SummaryCheck[];
  readonly ai: SummaryAi;
  readonly mutation?: MutationView;
  readonly hasLocalCheckout: boolean;
  readonly analysisMs?: number;
  readonly reproducibilityLimitations?: readonly string[];
}

/** Localized UI strings, resolved in the host (the webview has no l10n API). */
export type SummaryLabels = Readonly<Record<
  | 'noReview'
  | 'noReviewHint'
  | 'reviewCurrent'
  | 'reviewBranch'
  | 'riskTitle'
  | 'whyRisk'
  | 'limitations'
  | 'findings'
  | 'noFindings'
  | 'all'
  | 'groupBySeverity'
  | 'groupByFile'
  | 'whyStatus'
  | 'suggestedFix'
  | 'open'
  | 'dismiss'
  | 'restoreDismissed'
  | 'checks'
  | 'noChecks'
  | 'evidence'
  | 'markdown'
  | 'cancel'
  | 'reviewAgain'
  | 'staged'
  | 'commit'
  | 'pullRequest'
  | 'statusLegend'
  | 'aiTitle'
  | 'aiConnectHint'
  | 'aiConnect'
  | 'aiReadyHint'
  | 'aiRun'
  | 'aiRunAgain'
  | 'aiWhereToLook'
  | 'aiChange'
  | 'copyDescription'
  | 'localGit'
  | 'delivery'
  | 'deliveryHint'
  | 'publishPullRequest'
  | 'publishReview'
  | 'publishAnalysis'
  | 'pullRequestStatus'
  | 'mergePullRequest'
  | 'importSarif'
  | 'exportReport'
  | 'findingExplanation'
  | 'reportedObservation'
  | 'linkedEvidence'
  | 'linkedChecks'
  | 'missingProof'
  | 'noLinkedChecks'
  | 'comparison'
  | 'chooseComparison'
  | 'clearComparison'
  | 'comparisonEligibility'
  | 'newFindings'
  | 'persistingFindings'
  | 'noLongerObserved'
  | 'analysisDuration'
  | 'reproducibilityLimitations'
  | 'mutationMetricHelp' | 'mutationTitle' | 'mutationRun' | 'mutationOptional' | 'mutationExecution' | 'mutationVerification' | 'mutationBaseline' | 'mutationQuality' | 'mutationGate' | 'mutationScore' | 'mutationKilledOnly' | 'mutationDelta' | 'mutationRawStatus' | 'mutationAttribution' | 'mutationMutants' | 'mutationReportHash',
  string
>>;

export interface SummaryState {
  readonly labels: SummaryLabels;
  readonly busy?: string;
  readonly review?: SummaryReview;
  readonly comparison?: ComparisonView;
  readonly comparisonOptions?: readonly { readonly id: string; readonly label: string }[];
}

export type HostMessage = { readonly type: 'state'; readonly state: SummaryState };
