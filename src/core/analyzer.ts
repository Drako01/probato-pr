import type { ChangeSet, ReviewFinding, StaticEvidence } from './model';

/** Context handed to analyzers: the change under review plus a way to look at the rest of the repository. */
export interface AnalyzerContext {
  readonly changes: ChangeSet;
  /** Searches repository files (head side) for importers/usages; empty when no local checkout exists. */
  readonly workspace: WorkspaceIndex;
  readonly signal?: AbortSignal;
}

export interface WorkspaceIndex {
  /** Repository-relative paths of source files matching the predicate, bounded by the implementation. */
  listFiles(filter: (path: string) => boolean): Promise<readonly string[]>;
  read(path: string): Promise<string | undefined>;
}

export const EMPTY_WORKSPACE: WorkspaceIndex = {
  listFiles: () => Promise.resolve([]),
  read: () => Promise.resolve(undefined),
};

export interface AnalyzerOutput {
  readonly findings: readonly ReviewFinding[];
  readonly evidence: readonly StaticEvidence[];
  /** Coverage gaps (e.g. scan limits reached). Surfaced to the user; never dropped silently. */
  readonly limitations?: readonly string[];
}

/**
 * Deterministic analyzer. Implementations must only report facts they observed in real content
 * and must state their verification level honestly (AST facts are "evidenced"; heuristics "suspected").
 */
export interface Analyzer {
  readonly id: string;
  readonly description: string;
  /** Whether any file of this change set is in scope; out-of-scope analyzers are recorded as skipped. */
  appliesTo(changes: ChangeSet): boolean;
  analyze(context: AnalyzerContext): Promise<AnalyzerOutput>;
}
