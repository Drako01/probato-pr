/** Mutation states are independent of the core finding verification vocabulary. */
export const EXECUTION_STATUSES = ['NOT_REQUESTED', 'AWAITING_APPROVAL', 'QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED'] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];
export type MutationVerificationStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'ERROR' | 'INCONCLUSIVE';
export type BaselineStatus = 'COMPARABLE' | 'NOT_COMPARABLE' | 'MISSING';
export type QualityTrend = 'IMPROVED' | 'UNCHANGED' | 'DEGRADED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';
export type FindingAttribution = 'INTRODUCED' | 'PRE_EXISTING' | 'RESOLVED' | 'PERSISTENT' | 'UNKNOWN';
export type MutationStatus = 'KILLED' | 'SURVIVED' | 'NO_COVERAGE' | 'TIMED_OUT' | 'COMPILE_ERROR' | 'RUNTIME_ERROR' | 'IGNORED' | 'NOT_RUN';
export type GateDecision = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'INCONCLUSIVE';
export interface ExecutionEvent { readonly from: ExecutionStatus; readonly to: ExecutionStatus; readonly at: string; readonly cause: string }
export interface MutationExecution { readonly status: ExecutionStatus; readonly requestedAt: string; readonly events: readonly ExecutionEvent[] }
export interface MutationLimits { readonly timeoutMs: number; readonly concurrency: number; readonly memoryMb: number; readonly maxFiles: number; readonly maxReportBytes: number }
export interface MutationGatePolicy { readonly enabled: boolean; readonly failOnDegradation: boolean; readonly minimumScore?: number; readonly tolerancePoints: number }
export interface MutationRecord {
  readonly id: string; readonly identity: string; readonly file: string; readonly line: number; readonly column: number;
  readonly mutatorName: string; readonly replacement: string; readonly original: string; readonly rawStatus: string;
  readonly status: MutationStatus; readonly attribution: FindingAttribution; readonly reason?: string;
}
export interface MutationMetrics {
  /** Stryker score: (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage) * 100. */
  readonly mutationScore?: number;
  /** Separate stricter metric; timeouts do not count as killed. Never called Stryker Mutation Score. */
  readonly killedOnlyScore?: number;
  readonly detected: number; readonly undetected: number; readonly evaluated: number;
  readonly counts: Readonly<Record<MutationStatus, number>>;
}
export interface MutationReproducibility {
  readonly commit: string; readonly sourceHash: string; readonly dependencyHash: string; readonly configurationHash: string;
  readonly nodeVersion: string; readonly strykerVersion: string; readonly runner: string;
  readonly dependencyStatus?: 'comparable' | 'inconclusive';
  readonly dependencyReasons?: readonly string[];
  readonly dependencyVersions: Readonly<Record<string, string>>;
  /** Test content is the quality variable being compared; recorded separately from tool/runtime equivalence. */
  readonly testHash?: string;
  readonly conditionsHash: string;
}
export interface MutationRunEvidence {
  readonly id: string;
  readonly revision: 'head' | 'base'; readonly startedAt: string; readonly finishedAt: string; readonly durationMs: number;
  readonly commandLine: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly cancelled: boolean;
  readonly cwd?: string; readonly signal?: string | null; readonly dirty?: boolean; readonly outputTruncated?: boolean;
  readonly thresholdFailure?: boolean; readonly absoluteThreshold?: number;
  readonly outputSha256: string; readonly outputExcerpt: string; readonly reportSha256?: string;
  readonly report?: { readonly schemaVersion: string; readonly metrics: MutationMetrics; readonly mutants: readonly MutationRecord[] };
  readonly reproducibility?: MutationReproducibility;
  readonly error?: string;
}
export interface MutationResult {
  readonly schemaVersion: 1;
  readonly execution: MutationExecution;
  readonly verification: { readonly status: MutationVerificationStatus; readonly reasons: readonly string[] };
  readonly baseline: { readonly status: BaselineStatus; readonly reasons: readonly string[] };
  readonly quality: { readonly trend: QualityTrend; readonly deltaPoints?: number; readonly metric: 'stryker-mutation-score'; readonly reasons: readonly string[] };
  readonly gate: { readonly decision: GateDecision; readonly reasons: readonly string[] };
  readonly impactedFiles: readonly string[]; readonly limits: MutationLimits; readonly policy: MutationGatePolicy;
  readonly head?: MutationRunEvidence; readonly base?: MutationRunEvidence;
  readonly finishedAt?: string;
}
export const DEFAULT_MUTATION_LIMITS: MutationLimits = { timeoutMs: 600_000, concurrency: 1, memoryMb: 1024, maxFiles: 30, maxReportBytes: 20_000_000 };
export const DEFAULT_MUTATION_POLICY: MutationGatePolicy = { enabled: false, failOnDegradation: false, tolerancePoints: 0 };
