import { z } from 'zod';
import type { MutationResult } from '../mutation/model';

const text = z.string().max(2_000_000);
const identifier = z.string().min(1).max(2000);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const executionStatuses = ['NOT_REQUESTED', 'AWAITING_APPROVAL', 'QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED'] as const;
const mutationStatus = z.enum(['KILLED', 'SURVIVED', 'NO_COVERAGE', 'TIMED_OUT', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'IGNORED', 'NOT_RUN']);
const counts = z.object({ KILLED: count, SURVIVED: count, NO_COVERAGE: count, TIMED_OUT: count, COMPILE_ERROR: count, RUNTIME_ERROR: count, IGNORED: count, NOT_RUN: count });
const reasons = z.array(text).max(1000);
const score = z.number().min(0).max(100);
const run = z.object({
  id: identifier, revision: z.enum(['head', 'base']), startedAt: timestamp, finishedAt: timestamp, durationMs: z.number().nonnegative(),
  commandLine: text, exitCode: z.number().int().nullable(), timedOut: z.boolean(), cancelled: z.boolean(), outputSha256: hash, outputExcerpt: text,
  reportSha256: hash.optional(), error: text.optional(), thresholdFailure: z.boolean().optional(), absoluteThreshold: score.optional(),
  cwd: text.optional(), signal: text.nullable().optional(), dirty: z.boolean().optional(), outputTruncated: z.boolean().optional(),
  report: z.object({ schemaVersion: text, metrics: z.object({ mutationScore: score.optional(), killedOnlyScore: score.optional(), detected: count, undetected: count, evaluated: count, counts }),
    mutants: z.array(z.object({ id: identifier, identity: identifier, file: text, line: z.number().int().positive(), column: z.number().int().positive(), mutatorName: text, replacement: text, original: text, rawStatus: text, status: mutationStatus, attribution: z.enum(['INTRODUCED', 'PRE_EXISTING', 'RESOLVED', 'PERSISTENT', 'UNKNOWN']), reason: text.optional() })).max(100_000),
  }).optional(),
  reproducibility: z.object({ commit: identifier, sourceHash: hash, dependencyHash: hash, configurationHash: hash, nodeVersion: text, strykerVersion: text, runner: text, dependencyVersions: z.record(text, text), conditionsHash: hash, dependencyStatus: z.enum(['comparable', 'inconclusive']).optional(), dependencyReasons: reasons.optional(), testHash: hash.optional() }).optional(),
});
const mutation = z.object({
  schemaVersion: z.literal(1),
  execution: z.object({ status: z.enum(executionStatuses), requestedAt: timestamp, events: z.array(z.object({ from: z.enum(executionStatuses), to: z.enum(executionStatuses), at: timestamp, cause: z.string().min(1).max(100_000) })).max(20) }),
  verification: z.object({ status: z.enum(['PASS', 'FAIL', 'WARN', 'SKIP', 'ERROR', 'INCONCLUSIVE']), reasons }),
  baseline: z.object({ status: z.enum(['COMPARABLE', 'NOT_COMPARABLE', 'MISSING']), reasons }),
  quality: z.object({ trend: z.enum(['IMPROVED', 'UNCHANGED', 'DEGRADED', 'INCONCLUSIVE', 'NOT_APPLICABLE']), deltaPoints: z.number().min(-100).max(100).optional(), metric: z.literal('stryker-mutation-score'), reasons }),
  gate: z.object({ decision: z.enum(['PASS', 'FAIL', 'WARN', 'SKIP', 'INCONCLUSIVE']), reasons }),
  impactedFiles: z.array(text).max(200), limits: z.object({ timeoutMs: z.number().positive(), concurrency: z.number().int().positive(), memoryMb: z.number().positive(), maxFiles: z.number().int().positive(), maxReportBytes: z.number().int().positive() }),
  policy: z.object({ enabled: z.boolean(), failOnDegradation: z.boolean(), minimumScore: score.optional(), tolerancePoints: score }),
  head: run.optional(), base: run.optional(), finishedAt: timestamp.optional(),
}).superRefine((result, context) => {
  const reject = () => { context.addIssue({ code: 'custom', message: 'Inconsistent mutation evidence state' }); };
  const transitions: Readonly<Record<string, readonly string[]>> = { NOT_REQUESTED: ['AWAITING_APPROVAL', 'CANCELLED'], AWAITING_APPROVAL: ['QUEUED', 'CANCELLED'], QUEUED: ['RUNNING', 'CANCELLED'], RUNNING: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
  let current = 'NOT_REQUESTED';
  let time = Date.parse(result.execution.requestedAt);
  for (const event of result.execution.events) {
    if (event.from !== current || !transitions[current]?.includes(event.to) || Date.parse(event.at) < time) reject();
    current = event.to; time = Date.parse(event.at);
  }
  if (current !== result.execution.status) reject();
  const final = ['COMPLETED', 'CANCELLED'].includes(result.execution.status);
  if (final && (!result.finishedAt || Date.parse(result.finishedAt) < time)) reject();
  const validRun = (candidate: z.infer<typeof run> | undefined) => candidate?.report && !candidate.error && !candidate.cancelled && !candidate.timedOut && (candidate.exitCode === 0 || (candidate.exitCode === 1 && candidate.thresholdFailure === true && candidate.absoluteThreshold !== undefined && candidate.report.metrics.mutationScore !== undefined && candidate.report.metrics.mutationScore < candidate.absoluteThreshold));
  const measured = validRun(result.head);
  if (['PASS', 'FAIL', 'WARN'].includes(result.verification.status) && (result.execution.status !== 'COMPLETED' || !measured)) reject();
  if (result.execution.status === 'CANCELLED' && (result.verification.status === 'PASS' || result.gate.decision === 'PASS')) reject();
  const compared = result.baseline.status === 'COMPARABLE' && measured && validRun(result.base);
  if (['IMPROVED', 'UNCHANGED', 'DEGRADED'].includes(result.quality.trend) && !compared) reject();
  if (result.quality.deltaPoints !== undefined) {
    if (!compared) reject();
    const headScore = result.head?.report?.metrics.mutationScore;
    const baseScore = result.base?.report?.metrics.mutationScore;
    if (headScore === undefined || baseScore === undefined || Math.abs(result.quality.deltaPoints - (headScore - baseScore)) > 0.000001) reject();
  }
  if (['IMPROVED', 'UNCHANGED', 'DEGRADED'].includes(result.quality.trend) && result.quality.deltaPoints === undefined) reject();
  if (result.baseline.status === 'COMPARABLE' && !compared) reject();
  const score = result.head?.report?.metrics.mutationScore;
  const absoluteBreach = (score !== undefined && result.policy.minimumScore !== undefined && score < result.policy.minimumScore) || result.head?.thresholdFailure === true;
  const differentialBreach = result.quality.trend === 'DEGRADED' && result.policy.failOnDegradation;
  if (result.gate.decision === 'FAIL' && (!result.policy.enabled || !measured || !(absoluteBreach || differentialBreach) || ['ERROR', 'SKIP', 'INCONCLUSIVE'].includes(result.verification.status))) reject();
  if (result.gate.decision === 'PASS' && (result.execution.status !== 'COMPLETED' || !measured || ['ERROR', 'SKIP', 'INCONCLUSIVE', 'FAIL'].includes(result.verification.status))) reject();
});

/** Untrusted historical results cannot manufacture successful or comparable mutation executions. */
export function readStoredMutation(value: unknown): MutationResult | undefined {
  const parsed = mutation.safeParse(value);
  return parsed.success ? parsed.data as unknown as MutationResult : undefined;
}
