import { describe, expect, it } from 'vitest';
import { parseStrykerReport } from '../../src/mutation/report';
import { compareMutationRuns } from '../../src/mutation/compare';
import { startMutationExecution, transitionMutationExecution } from '../../src/mutation/state';
import type { ExecutionStatus, MutationGatePolicy, MutationRunEvidence } from '../../src/mutation/model';

const policy: MutationGatePolicy = { enabled: true, failOnDegradation: true, minimumScore: 75, tolerancePoints: 0 };
function run(killed: number, revision: 'head' | 'base' = 'head'): MutationRunEvidence & Required<Pick<MutationRunEvidence, 'report' | 'reproducibility'>> {
  const parsed = parseStrykerReport({ schemaVersion: '3', files: { 'src/a.ts': { source: 'export const x = true;\n', mutants: Array.from({ length: 100 }, (_, i) => ({ id: String(i), mutatorName: `Boolean${i}`, replacement: 'false', status: i < killed ? 'Killed' : 'Survived', location: { start: { line: 1, column: 18 }, end: { line: 1, column: 22 } } })) } } }, ['src/a.ts']);
  return { id: `run-${revision}`, revision, startedAt: '2026-11-03T10:00:00Z', finishedAt: '2026-11-03T10:00:01Z', durationMs: 1000, commandLine: 'node stryker run', exitCode: 0, timedOut: false, cancelled: false, outputSha256: 'a'.repeat(64), outputExcerpt: '', report: parsed, reportSha256: 'b'.repeat(64), reproducibility: { commit: revision, sourceHash: parsed.sourceHash, dependencyHash: 'dependencies', configurationHash: 'config', nodeVersion: '24', strykerVersion: '10.1.1', runner: 'command', dependencyVersions: { stryker: '10.1.1' }, conditionsHash: 'conditions' } };
}

describe('mutation state machine', () => {
  const allowed: Record<ExecutionStatus, readonly ExecutionStatus[]> = { NOT_REQUESTED: ['AWAITING_APPROVAL', 'CANCELLED'], AWAITING_APPROVAL: ['QUEUED', 'CANCELLED'], QUEUED: ['RUNNING', 'CANCELLED'], RUNNING: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
  for (const from of Object.keys(allowed) as ExecutionStatus[]) for (const to of Object.keys(allowed) as ExecutionStatus[]) {
    it(`${from} -> ${to} is ${allowed[from].includes(to) ? 'allowed' : 'rejected'}`, () => {
      const state = { ...startMutationExecution(), status: from };
      if (allowed[from].includes(to)) expect(transitionMutationExecution(state, to, 'cause').events[0]).toMatchObject({ from, to, cause: 'cause' });
      else expect(() => transitionMutationExecution(state, to, 'cause')).toThrow(/Invalid mutation/);
    });
  }
});

describe('differential mutation quality', () => {
  it('detects 85 to 78 as -7 percentage points even though both exceed the minimum 75', () => {
    const result = compareMutationRuns(run(78), run(85, 'base'), policy);
    expect(result.baseline.status).toBe('COMPARABLE');
    expect(result.quality).toMatchObject({ trend: 'DEGRADED', deltaPoints: -7 });
    expect(result.verification.status).toBe('FAIL'); expect(result.gate.decision).toBe('FAIL');
    expect(result.head?.report?.mutants.filter((m) => m.attribution === 'INTRODUCED')).toHaveLength(7);
    expect(result.head?.report?.mutants.filter((m) => m.attribution === 'PERSISTENT')).toHaveLength(15);
  });
  it('does not classify pre-existing survivors as new regressions', () => {
    const result = compareMutationRuns(run(85), run(85, 'base'), policy);
    expect(result.quality).toMatchObject({ trend: 'UNCHANGED', deltaPoints: 0 }); expect(result.gate.decision).toBe('PASS');
    expect(result.head?.report?.mutants.filter((m) => m.attribution === 'INTRODUCED')).toHaveLength(0);
    expect(result.head?.report?.mutants.filter((m) => m.attribution === 'PERSISTENT')).toHaveLength(15);
  });
  it('demonstrates resolution only when the equivalent surviving mutant is actually killed', () => {
    const result = compareMutationRuns(run(90), run(85, 'base'), policy);
    expect(result.quality.trend).toBe('IMPROVED');
    expect(result.head?.report?.mutants.filter((m) => m.attribution === 'RESOLVED')).toHaveLength(5);
  });
  it.each(['sourceHash', 'dependencyHash', 'configurationHash', 'conditionsHash', 'nodeVersion', 'strykerVersion'] as const)('does not quantify a trend when %s differs', (field) => {
    const head = run(78); expect(head.reproducibility).toBeDefined();
    const result = compareMutationRuns({ ...head, reproducibility: { ...head.reproducibility, [field]: 'different' } }, run(85, 'base'), policy);
    expect(result.baseline.status).toBe('NOT_COMPARABLE'); expect(result.quality.trend).toBe('INCONCLUSIVE'); expect(result.quality.deltaPoints).toBeUndefined(); expect(result.gate.decision).toBe('INCONCLUSIVE');
  });
  it('does not compare different mutation populations or infer resolution from disappearance', () => {
    const head = run(78); const result = compareMutationRuns({ ...head, report: { ...head.report, mutants: head.report.mutants.slice(1) } }, run(85, 'base'), policy);
    expect(result.quality.trend).toBe('INCONCLUSIVE'); expect(result.quality.deltaPoints).toBeUndefined();
    expect(result.head?.report?.mutants.some((m) => m.attribution === 'RESOLVED')).toBe(false);
  });
  it('separates policy-disabled, warning, missing baseline, infrastructure errors and cancellation', () => {
    expect(compareMutationRuns(run(78), run(85, 'base'), { ...policy, enabled: false }).gate.decision).toBe('SKIP');
    expect(compareMutationRuns(run(78), run(85, 'base'), { ...policy, failOnDegradation: false }).gate.decision).toBe('WARN');
    expect(compareMutationRuns(run(78), undefined, policy).baseline.status).toBe('MISSING');
    expect(compareMutationRuns(run(78), undefined, policy).quality.deltaPoints).toBeUndefined();
    expect(compareMutationRuns({ ...run(78), exitCode: 1 }, run(85, 'base'), policy).verification.status).toBe('ERROR');
    expect(compareMutationRuns({ ...run(78), cancelled: true }, run(85, 'base'), policy).verification.status).toBe('INCONCLUSIVE');
    expect(compareMutationRuns({ ...run(78), error: 'report invalid' }, run(85, 'base'), policy).gate.decision).toBe('INCONCLUSIVE');
  });
  it('normalizes all raw statuses while preserving their names and distinct metric meaning', () => {
    const statuses = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'];
    const report = parseStrykerReport({ schemaVersion: '3', files: { 'a.ts': { source: 'true', mutants: statuses.map((status, i) => ({ id: String(i), status, mutatorName: 'Boolean', replacement: 'false', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } })) } } });
    expect(report.mutants.map((m) => m.rawStatus)).toEqual(statuses);
    expect(report.mutants.map((m) => m.status)).toEqual(['KILLED', 'SURVIVED', 'NO_COVERAGE', 'TIMED_OUT', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'IGNORED', 'NOT_RUN']);
    expect(report.metrics.mutationScore).toBe(50); expect(report.metrics.killedOnlyScore).toBe(25);
  });
  it('rejects report files outside authorized impact and invalid locations', () => {
    expect(() => parseStrykerReport({ schemaVersion: '3', files: { '../outside.ts': { source: '', mutants: [] } } })).toThrow(/authorized impact/);
    expect(() => parseStrykerReport({ schemaVersion: '3', files: { 'a.ts': { source: 'true', mutants: [{ id: '0', status: 'Killed', mutatorName: 'Bool', replacement: 'false', location: { start: { line: 1, column: 1 }, end: { line: 9, column: 1 } } }] } } })).toThrow(/source location/);
  });
});
