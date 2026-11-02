// Domain model shared by every layer. Pure types: no VS Code, Git or Node I/O here.

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How strongly a finding is backed:
 * - confirmed: verified by an executed check and attributable to the change when presented as a regression.
 * - evidenced: objective technical evidence exists (AST fact, failing check) but causality is not fully proven.
 * - suspected: probable issue from heuristics or AI, not backed by executed verification.
 * - not-verified: the verification this finding needs could not be performed (reason in verificationNote).
 */
export const VERIFICATION_STATUSES = ['confirmed', 'evidenced', 'suspected', 'not-verified'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type FindingOrigin = 'analyzer' | 'verification' | 'ai';

/** Causal relation between a defect and the reviewed change, from base-vs-head comparison. */
export type Attribution = 'introduced' | 'pre-existing' | 'fixed' | 'inconclusive' | 'unknown';

/** Repository-relative POSIX path plus 1-based line range. */
export interface SourceLocation {
  readonly file: string;
  readonly startLine: number;
  readonly endLine?: number;
}

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly summary: string;
}

export interface ReviewFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly verification: VerificationStatus;
  /** Plain-language reason for the verification status (what was or was not proven). */
  readonly verificationNote: string;
  readonly origin: FindingOrigin;
  readonly title: string;
  readonly description: string;
  readonly location: SourceLocation;
  readonly evidence: readonly EvidenceReference[];
  readonly attribution?: Attribution;
  readonly suggestedFix?: string;
}

// ---------------------------------------------------------------------------
// Evidence: produced only by analyzers that inspected real content or by the
// process runner that actually executed a command. Never synthesized.

export interface StaticEvidence {
  readonly kind: 'static-analysis';
  readonly id: string;
  readonly analyzerId: string;
  readonly description: string;
  readonly locations: readonly SourceLocation[];
  readonly excerpt?: string;
}

export type CommandOutcome = 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'error';
export type Revision = 'head' | 'base';

export interface CommandEvidence {
  readonly kind: 'command-run';
  readonly id: string;
  readonly checkId: string;
  readonly revision: Revision;
  readonly commitSha: string | undefined;
  /** True when the head run included uncommitted working-tree changes. */
  readonly dirty: boolean;
  readonly commandLine: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outcome: CommandOutcome;
  /** Tail of combined stdout/stderr with secrets redacted. */
  readonly outputExcerpt: string;
  readonly outputTruncated: boolean;
  /** SHA-256 of the full captured (pre-truncation, pre-redaction) output, for reproducibility checks. */
  readonly outputSha256: string;
  readonly errorMessage?: string;
}

export type Evidence = StaticEvidence | CommandEvidence;

// ---------------------------------------------------------------------------
// Change sets

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface DiffLine {
  readonly kind: 'add' | 'del' | 'context';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface FileChange {
  /** Path on the head side (for deletions, the deleted path). */
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

export type ReviewScopeKind = 'working' | 'staged' | 'branch' | 'commit' | 'pull-request';

export interface ReviewScope {
  readonly kind: ReviewScopeKind;
  readonly label: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly headRef?: string;
  readonly headSha?: string;
  /** Head content comes from the working tree (uncommitted edits included). */
  readonly headIsWorkingTree: boolean;
  readonly pullRequest?: { readonly owner: string; readonly repo: string; readonly number: number; readonly url: string };
}

export interface RepositoryInfo {
  readonly name: string;
  /** Absolute path of the repository root; empty for remote-only reviews. */
  readonly root: string;
  readonly branch: string | undefined;
  readonly headSha: string | undefined;
}

export type ChangeSide = 'base' | 'head';

/** Reads file content on either side of a change; undefined when the file does not exist there. */
export interface ContentProvider {
  read(path: string, side: ChangeSide): Promise<string | undefined>;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface ChangeSet {
  readonly scope: ReviewScope;
  readonly repository: RepositoryInfo;
  readonly files: readonly FileChange[];
  readonly skipped: readonly SkippedFile[];
  readonly content: ContentProvider;
}

// ---------------------------------------------------------------------------
// Verification

export type CheckKind = 'typecheck' | 'lint' | 'test' | 'build' | 'vet';
export type OutputFormat = 'tsc' | 'go' | 'plain';

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface PlannedCheck {
  readonly id: string;
  readonly kind: CheckKind;
  readonly label: string;
  readonly command: CommandSpec;
  /** Directory relative to the repository root ('' for the root). */
  readonly cwd: string;
  readonly rationale: string;
  /** Risks the user must see before approving (e.g. "runs a repository script"). */
  readonly warnings: readonly string[];
  /** External resources the command appears to need (database, Docker, network...). */
  readonly requires: readonly string[];
  readonly outputFormat: OutputFormat;
}

export type CheckStatus = 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'error' | 'pending';

export interface CheckResult {
  readonly checkId: string;
  readonly kind: CheckKind;
  readonly label: string;
  readonly commandLine: string;
  readonly status: CheckStatus;
  readonly headEvidenceId?: string;
  readonly baseEvidenceId?: string;
  readonly attribution: Attribution;
  readonly attributionNote: string;
}

export interface AnalyzerRun {
  readonly analyzerId: string;
  readonly status: 'ran' | 'skipped' | 'failed';
  readonly detail?: string;
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
  readonly limitations: readonly string[];
  readonly counts: {
    readonly byVerification: Readonly<Record<VerificationStatus, number>>;
    readonly bySeverity: Readonly<Record<Severity, number>>;
    readonly checks: Readonly<Record<'passed' | 'failed' | 'notRun', number>>;
    readonly regressions: number;
  };
}

export interface ReviewStats {
  readonly filesChanged: number;
  readonly filesSkipped: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ReviewResult {
  readonly id: string;
  readonly createdAt: string;
  readonly toolVersion: string;
  readonly scope: ReviewScope;
  readonly repository: RepositoryInfo;
  readonly stats: ReviewStats;
  readonly changedFiles: readonly string[];
  readonly skipped: readonly SkippedFile[];
  readonly findings: readonly ReviewFinding[];
  readonly evidence: readonly Evidence[];
  readonly checks: readonly CheckResult[];
  readonly analyzerRuns: readonly AnalyzerRun[];
  readonly aiRuns: readonly AiRunRecord[];
  /** Walkthrough of the change written by the optional AI reviewer (latest run). Descriptive, never evidence. */
  readonly aiSummary?: AiSummary;
  readonly risk: RiskAssessment;
}

export interface AiRunRecord {
  readonly providerId: string;
  readonly model: string;
  readonly startedAt: string;
  readonly filesShared: readonly string[];
  readonly accepted: number;
  readonly rejected: number;
  readonly rejectionReasons: readonly string[];
}

export interface AiSummary {
  /** Provider and model that wrote it, e.g. "Anthropic Claude (claude-opus-5-5)". */
  readonly author: string;
  readonly overview: string;
  /** One entry per changed file the model described; only files that were shared with it. */
  readonly changes: readonly { readonly file: string; readonly summary: string }[];
  /** Where a human reviewer should look first. */
  readonly reviewFocus: readonly string[];
}
