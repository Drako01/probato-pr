// The guided Review → Verify → Share flow. Pure: shared by the Overview tree, the status bar and the summary panel
// so every surface shows the same step states and the same next action.

export type StepState = 'done' | 'current' | 'todo' | 'unavailable';

/** Why verification cannot run for the current review. */
export type VerifyBlocker = 'remote-only' | 'no-checks';

export type NextAction = 'review' | 'verify' | 'share';

export interface WorkflowInput {
  readonly hasReview: boolean;
  /** The review has a local checkout to run checks in (false for API-only pull request reviews). */
  readonly hasLocalCheckout: boolean;
  readonly checksRun: number;
  /** Checks detected for the repository; undefined while detection has not run. */
  readonly checksAvailable: number | undefined;
}

export interface Workflow {
  readonly review: StepState;
  readonly verify: StepState;
  readonly share: StepState;
  readonly verifyBlocker?: VerifyBlocker;
  readonly next: NextAction;
}

export function workflowOf(input: WorkflowInput): Workflow {
  if (!input.hasReview) {
    return { review: 'current', verify: 'todo', share: 'todo', next: 'review' };
  }
  if (input.checksRun > 0) {
    return { review: 'done', verify: 'done', share: 'current', next: 'share' };
  }
  const verifyBlocker: VerifyBlocker | undefined = !input.hasLocalCheckout ? 'remote-only' : input.checksAvailable === 0 ? 'no-checks' : undefined;
  if (verifyBlocker) {
    return { review: 'done', verify: 'unavailable', share: 'current', verifyBlocker, next: 'share' };
  }
  return { review: 'done', verify: 'current', share: 'todo', next: 'verify' };
}
