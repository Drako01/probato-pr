import * as vscode from 'vscode';
import type { CommandEvidence, PlannedCheck, ReviewFinding, ReviewResult } from '../core/model';
import type { HistoryEntry, HistoryStore } from '../infrastructure/history-store';
import { compareReviews, comparisonBlocker, type ReviewComparison } from '../core/review-comparison';
import type { MutationResult } from '../mutation/model';
import { workflowOf, type Workflow } from '../ui/workflow';
import { applyVerification } from '../verification/evidence-linker';
import type { VerificationOutcome } from '../verification/verification-engine';

const DISMISSED_KEY = 'probatoPR.dismissedFindings';
const MAX_DISMISSED = 2000;

export class BusyError extends Error {
  constructor(readonly activity: string) {
    super(`Probato PR is already running: ${activity}.`);
    this.name = 'BusyError';
  }
}

/**
 * Single source of truth for the review shown in the UI. The analyzer/AI review is kept separately
 * from verification so verification can be re-applied (or re-run) without stacking results.
 */
export class ReviewSession implements vscode.Disposable {
  private review: ReviewResult | undefined;
  private comparisonBase: ReviewResult | undefined;
  private comparisonResult: ReviewComparison | undefined;
  private comparisonGeneration = 0;
  private previousReview: ReviewResult | undefined;
  private outcome: VerificationOutcome | undefined;
  private view: ReviewResult | undefined;
  /** Checks detected for the current review; undefined until detection ran (e.g. after a restore). */
  private planned: readonly PlannedCheck[] | undefined;
  private running: { readonly label: string; readonly controller: AbortController } | undefined;
  private readonly dismissed: Set<string>;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly history: HistoryStore,
    private readonly onPersistError: (error: unknown) => void,
  ) {
    this.dismissed = new Set(memento.get<string[]>(DISMISSED_KEY, []));
  }

  get current(): ReviewResult | undefined {
    return this.view;
  }

  get comparison(): ReviewComparison | undefined { return this.comparisonResult; }

  /** Historical snapshots are read only; selecting one never restores current evidence or approvals. */
  async comparisonOptions(): Promise<readonly HistoryEntry[]> {
    const current = this.view;
    if (!current) return [];
    const stored = await this.history.load();
    if (this.view !== current) return [];
    return stored.history.filter((entry) => stored.snapshots.some((snapshot) => snapshot.id === entry.id && comparisonBlocker(snapshot, current) === undefined));
  }

  async compareWith(id: string): Promise<ReviewComparison | undefined> {
    const current = this.view;
    if (!current || this.running) return undefined;
    const generation = ++this.comparisonGeneration;
    const previous = await this.history.findReview(id);
    if (!previous || this.view !== current || generation !== this.comparisonGeneration) return undefined;
    this.comparisonBase = previous;
    this.comparisonResult = compareReviews(previous, current);
    this.emitter.fire();
    return this.comparisonResult;
  }

  clearComparison(): void {
    this.comparisonGeneration++;
    this.comparisonBase = undefined;
    this.comparisonResult = undefined;
    this.emitter.fire();
  }

  get base(): ReviewResult | undefined {
    return this.review;
  }

  get plan(): readonly PlannedCheck[] {
    return this.planned ?? [];
  }

  workflow(): Workflow {
    return workflowOf({
      hasReview: this.view !== undefined,
      hasLocalCheckout: Boolean(this.view?.repository.root),
      checksRun: this.view?.checks.length ?? 0,
      checksAvailable: this.planned?.length,
    });
  }

  get busyLabel(): string | undefined {
    return this.running?.label;
  }

  visibleFindings(): ReviewFinding[] {
    return this.view?.findings.filter((f) => !this.dismissed.has(f.id)) ?? [];
  }

  dismissedCount(): number {
    return this.view?.findings.filter((f) => this.dismissed.has(f.id)).length ?? 0;
  }

  restore(review: ReviewResult, verified: ReviewResult | undefined): void {
    this.comparisonGeneration++;
    this.comparisonBase = undefined;
    this.comparisonResult = undefined;
    this.review = review;
    this.outcome = undefined;
    this.view = verified ?? review;
    this.changed(false);
  }

  setReview(review: ReviewResult): void {
    this.comparisonGeneration++;
    const previous = this.view ?? this.previousReview;
    this.comparisonBase = previous && comparisonBlocker(previous, review) === undefined ? previous : undefined;
    this.previousReview = undefined;
    this.review = review;
    this.outcome = undefined;
    this.planned = undefined;
    this.view = review;
    this.changed(true);
  }

  /** Replaces the analyzer/AI part (e.g. after AI findings were added) and re-applies the last verification. */
  updateReview(review: ReviewResult): void {
    this.review = review;
    this.view = this.outcome ? applyVerification(review, this.outcome) : review;
    this.changed(true);
  }

  /** Re-renders views when external state changes (e.g. workspace trust granted). */
  updateViews(): void {
    this.emitter.fire();
  }

  setPlan(plan: readonly PlannedCheck[]): void {
    this.planned = plan;
    this.emitter.fire();
  }

  setVerification(outcome: VerificationOutcome): void {
    if (!this.review) {
      return;
    }
    this.outcome = outcome;
    this.view = applyVerification(this.review, outcome);
    this.changed(true);
  }

  /** Mutation has its own outcomes; normal verification evidence and status stay independent. */
  setMutation(result: MutationResult, evidence: readonly CommandEvidence[]): void {
    if (!this.review) return;
    const priorIds = new Set([this.review.mutation?.head?.id, this.review.mutation?.base?.id].filter((id): id is string => id !== undefined));
    this.review = { ...this.review, mutation: result, evidence: [...this.review.evidence.filter((entry) => !priorIds.has(entry.id)), ...evidence] };
    this.view = this.outcome ? applyVerification(this.review, this.outcome) : this.review;
    this.changed(result.execution.status === 'COMPLETED' || result.execution.status === 'CANCELLED');
  }

  async dismiss(findingId: string): Promise<void> {
    this.dismissed.add(findingId);
    await this.memento.update(DISMISSED_KEY, [...this.dismissed].slice(-MAX_DISMISSED));
    this.emitter.fire();
  }

  async restoreDismissed(): Promise<void> {
    this.dismissed.clear();
    await this.memento.update(DISMISSED_KEY, []);
    this.emitter.fire();
  }

  /** Runs one operation at a time; a second request while busy is rejected instead of racing. */
  async exclusive<T>(label: string, operation: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    if (this.running) {
      throw new BusyError(this.running.label);
    }
    const controller = new AbortController();
    this.running = { label, controller };
    await vscode.commands.executeCommand('setContext', 'probatoPR.busy', true);
    this.emitter.fire();
    try {
      return await operation(controller.signal);
    } finally {
      this.running = undefined;
      await vscode.commands.executeCommand('setContext', 'probatoPR.busy', false);
      this.emitter.fire();
    }
  }

  cancel(): boolean {
    if (!this.running) {
      return false;
    }
    this.running.controller.abort();
    return true;
  }

  /** A Git/content mutation invalidates evidence and results until a new review completes. */
  invalidate(): void {
    this.previousReview = this.view ?? this.previousReview;
    this.comparisonGeneration++;
    this.comparisonBase = undefined;
    this.comparisonResult = undefined;
    this.review = undefined;
    this.outcome = undefined;
    this.view = undefined;
    this.planned = undefined;
    this.changed(false);
  }

  async clear(): Promise<void> {
    this.previousReview = undefined;
    this.comparisonGeneration++;
    this.comparisonBase = undefined;
    this.comparisonResult = undefined;
    this.review = undefined;
    this.outcome = undefined;
    this.view = undefined;
    this.planned = undefined;
    await this.history.clear();
    this.changed(false);
  }

  private changed(persist: boolean): void {
    this.comparisonGeneration++;
    this.comparisonResult = this.comparisonBase && this.view ? compareReviews(this.comparisonBase, this.view) : undefined;
    void vscode.commands.executeCommand('setContext', 'probatoPR.hasReview', this.view !== undefined);
    if (persist && this.review) {
      this.history.save(this.review, this.view === this.review ? undefined : this.view).then(() => { this.emitter.fire(); }).catch(this.onPersistError);
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.running?.controller.abort();
    this.emitter.dispose();
  }
}
