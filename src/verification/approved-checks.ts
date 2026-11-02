import type { PlannedCheck } from '../core/model';

/** Key-value storage outside the repository (VS Code's workspace Memento satisfies it). */
export interface ApprovalStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  keys(): readonly string[];
}

/** Check id → fingerprint of what was approved. */
type Approvals = Readonly<Record<string, string>>;

export interface ApprovalMatch {
  /** Remembered checks whose command and script are unchanged: they may run without asking again. */
  readonly approved: readonly PlannedCheck[];
  /** Remembered checks whose command or script changed since approval: they must be approved again. */
  readonly changed: readonly PlannedCheck[];
}

const PREFIX = 'probatoPR.approvedChecks:';

/** Stored state is outside our control (older versions, manual edits): anything malformed counts as "nothing approved". */
function approvalsOf(value: unknown): Approvals {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/**
 * Checks the user chose to run without asking again, per repository. An approval is bound to the check's
 * fingerprint (command, directory, script body), so editing a script, even in a branch someone else wrote,
 * voids it and the user is asked again.
 */
export class ApprovedChecks {
  constructor(private readonly store: ApprovalStore) {}

  match(root: string, plan: readonly PlannedCheck[]): ApprovalMatch {
    const remembered = approvalsOf(this.store.get(PREFIX + root));
    return {
      approved: plan.filter((check) => remembered[check.id] === check.fingerprint),
      changed: plan.filter((check) => remembered[check.id] !== undefined && remembered[check.id] !== check.fingerprint),
    };
  }

  remember(root: string, checks: readonly PlannedCheck[]): PromiseLike<void> {
    const approvals: Approvals = Object.fromEntries(checks.map((check) => [check.id, check.fingerprint]));
    return this.store.update(PREFIX + root, approvals);
  }

  forget(root: string): PromiseLike<void> {
    return this.store.update(PREFIX + root, undefined);
  }

  async forgetAll(): Promise<number> {
    const keys = this.store.keys().filter((key) => key.startsWith(PREFIX));
    await Promise.all(keys.map((key) => this.store.update(key, undefined)));
    return keys.length;
  }
}
