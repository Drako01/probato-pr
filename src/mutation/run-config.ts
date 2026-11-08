import type { RepositoryPolicy } from '../core/repository-policy';
import type { MutationGatePolicy, MutationLimits } from './model';

/** User-level mutation settings (VS Code configuration), already validated by the settings schema. */
export interface MutationUserSettings {
  readonly timeoutSeconds: number; readonly concurrency: number; readonly memoryMb: number; readonly maxFiles: number;
  readonly gateEnabled: boolean; readonly failOnDegradation: boolean; readonly minimumScore: number; readonly tolerancePoints: number;
}

export interface MutationRunConfig {
  readonly limits: Omit<MutationLimits, 'maxReportBytes'>;
  readonly gatePolicy: MutationGatePolicy;
}

/**
 * Resource limits always come from the user; the repository policy may only set the gate fields it declares.
 * A repository can therefore tighten or relax its own gate, never the time, memory or concurrency budget.
 */
export function mutationRunConfig(settings: MutationUserSettings, policy?: RepositoryPolicy['mutation']): MutationRunConfig {
  return {
    limits: { timeoutMs: settings.timeoutSeconds * 1000, concurrency: settings.concurrency, memoryMb: settings.memoryMb, maxFiles: settings.maxFiles },
    gatePolicy: {
      enabled: policy?.enabled ?? settings.gateEnabled,
      failOnDegradation: policy?.failOnDegradation ?? settings.failOnDegradation,
      minimumScore: policy?.minimumScore ?? settings.minimumScore,
      tolerancePoints: policy?.tolerancePoints ?? settings.tolerancePoints,
    },
  };
}
