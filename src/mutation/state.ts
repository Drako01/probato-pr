import { tr } from '../core/i18n';
import type { ExecutionStatus, MutationExecution } from './model';

const NEXT: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  NOT_REQUESTED: ['AWAITING_APPROVAL', 'CANCELLED'], AWAITING_APPROVAL: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED'], RUNNING: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [],
};
export function startMutationExecution(at = new Date().toISOString()): MutationExecution { return { status: 'NOT_REQUESTED', requestedAt: at, events: [] }; }
export function transitionMutationExecution(execution: MutationExecution, to: ExecutionStatus, cause: string, at = new Date().toISOString()): MutationExecution {
  if (!NEXT[execution.status].includes(to)) throw new Error(tr('Invalid mutation execution transition: {0} to {1}.', execution.status, to));
  return { ...execution, status: to, events: [...execution.events, { from: execution.status, to, cause, at }] };
}
