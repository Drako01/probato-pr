import { afterEach, describe, expect, it } from 'vitest';
import { setTranslator } from '../../src/core/i18n';
import type { CommandEvidence } from '../../src/core/model';
import { readStoredMutation } from '../../src/infrastructure/mutation-history-schema';
import type { MutationResult, MutationRunEvidence } from '../../src/mutation/model';
import { mutationView } from '../../src/ui/mutation-view-model';

const time = '2026-11-03T12:00:00.000Z';
function run(revision: 'head' | 'base', killed: number): MutationRunEvidence {
  const outputSha256 = (revision === 'head' ? 'a' : 'b').repeat(64);
  return { id: `mutation-${revision}-${outputSha256}`, revision, startedAt: time, finishedAt: time, durationMs: 0, commandLine: 'stryker run', exitCode: 0, timedOut: false, cancelled: false, outputSha256, outputExcerpt: 'raw tool output', reportSha256: 'c'.repeat(64),
    report: { schemaVersion: '1', metrics: { mutationScore: killed, killedOnlyScore: killed, detected: killed, undetected: 100 - killed, evaluated: 100, counts: { KILLED: killed, SURVIVED: 100 - killed, NO_COVERAGE: 0, TIMED_OUT: 0, COMPILE_ERROR: 0, RUNTIME_ERROR: 0, IGNORED: 0, NOT_RUN: 0 } }, mutants: Array.from({ length: 100 }, (_, index) => ({ id: String(index), identity: String(index), file: 'src/score.ts', line: index + 1, column: 1, mutatorName: 'BooleanLiteral', replacement: 'false', original: 'true', rawStatus: index < killed ? 'Killed' : 'Survived', status: index < killed ? 'KILLED' as const : 'SURVIVED' as const, attribution: 'PERSISTENT' as const })) },
    reproducibility: { commit: 'a'.repeat(40), sourceHash: 'd'.repeat(64), dependencyHash: 'e'.repeat(64), configurationHash: 'f'.repeat(64), nodeVersion: '22', strykerVersion: '9', runner: 'command', dependencyVersions: {}, conditionsHash: '1'.repeat(64) },
  };
}
function result(): MutationResult {
  return { schemaVersion: 1,
    execution: { status: 'COMPLETED', requestedAt: time, events: [{ from: 'NOT_REQUESTED', to: 'AWAITING_APPROVAL', at: time, cause: 'requested' }, { from: 'AWAITING_APPROVAL', to: 'QUEUED', at: time, cause: 'approved' }, { from: 'QUEUED', to: 'RUNNING', at: time, cause: 'started' }, { from: 'RUNNING', to: 'COMPLETED', at: time, cause: 'finished' }] },
    verification: { status: 'FAIL', reasons: ['degradation demonstrated'] }, baseline: { status: 'COMPARABLE', reasons: [] },
    quality: { trend: 'DEGRADED', deltaPoints: -7, metric: 'stryker-mutation-score', reasons: [] }, gate: { decision: 'FAIL', reasons: ['policy rejects degradation'] },
    impactedFiles: ['src/score.ts'], limits: { timeoutMs: 1000, concurrency: 1, memoryMb: 256, maxFiles: 1, maxReportBytes: 100_000 },
    policy: { enabled: true, failOnDegradation: true, minimumScore: 75, tolerancePoints: 0 }, head: run('head', 78), base: run('base', 85), finishedAt: time,
  };
}
afterEach(() => { setTranslator(undefined); });
describe('mutation UI and historical consistency', () => {
  it('presents completed execution, failed verification, degraded quality and failed gate separately', () => {
    setTranslator((template) => ({ 'Mutation execution completed': 'Ejecución completada', 'Mutation criterion failed': 'Criterio incumplido', 'Mutation quality degraded': 'Calidad degradada', 'Quality gate failed': 'Gate rechazado' }[template] ?? template));
    const state = mutationView(result(), []);
    expect(state.execution).toEqual({ value: 'COMPLETED', label: 'Ejecución completada' });
    expect(state.verification.value).toBe('FAIL'); expect(state.verification.label).toBe('Criterio incumplido');
    expect(state.quality.value).toBe('DEGRADED'); expect(state.quality.deltaPoints).toBe(-7);
    expect(state.gate.value).toBe('FAIL');
    expect(state.runs.map((entry) => entry.score)).toEqual([85, 78]);
    expect(state.mutants.find((entry) => entry.rawStatus === 'Survived')).toBeDefined();
    expect(state.runs.every((entry) => entry.evidenceId === undefined)).toBe(true);
  });
  it('links a run only to matching actual command evidence', () => {
    const mutation = result(); const head = mutation.head as MutationRunEvidence;
    const evidence: CommandEvidence = { kind: 'command-run', id: head.id, checkId: 'mutation', revision: 'head', commitSha: 'a'.repeat(40), dirty: false, commandLine: head.commandLine, cwd: '', startedAt: time, durationMs: 0, exitCode: 0, signal: null, outcome: 'passed', outputExcerpt: '', outputTruncated: false, outputSha256: head.outputSha256 };
    expect(mutationView(mutation, [evidence]).runs[1]?.evidenceId).toBe(head.id);
    expect(mutationView(mutation, [{ ...evidence, outputSha256: '9'.repeat(64) }]).runs[1]?.evidenceId).toBeUndefined();
  });
  it('accepts evidence-backed independent final dimensions', () => { expect(readStoredMutation(result())?.quality.deltaPoints).toBe(-7); });
  it('rejects fake success, illegal transitions, misleading deltas and incomparable degradation', () => {
    const original = result();
    expect(readStoredMutation({ ...original, head: undefined })).toBeUndefined();
    expect(readStoredMutation({ ...original, execution: { ...original.execution, events: [{ from: 'NOT_REQUESTED', to: 'COMPLETED', at: time, cause: 'fake' }] } })).toBeUndefined();
    expect(readStoredMutation({ ...original, quality: { ...original.quality, deltaPoints: -2 } })).toBeUndefined();
    expect(readStoredMutation({ ...original, baseline: { status: 'NOT_COMPARABLE', reasons: ['changed source'] } })).toBeUndefined();
    expect(readStoredMutation({ ...original, verification: { status: 'ERROR', reasons: ['infra'] } })).toBeUndefined();
    expect(readStoredMutation({ ...original, execution: { ...original.execution, status: 'CANCELLED' }, verification: { status: 'PASS', reasons: [] } })).toBeUndefined();
  });
});
