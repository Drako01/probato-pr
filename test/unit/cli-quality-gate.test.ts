import { describe, expect, it } from 'vitest';
import { parseCliArgs, reportExitCode, runCli } from '../../src/cli';
import { ReviewEngine } from '../../src/core/review-engine';
import { createMutationResult } from '../../src/mutation/engine';
import { transitionMutationExecution } from '../../src/mutation/state';
import { changeSetOf, workspaceOf, tempDir, initRepo } from './helpers';

async function reviewWithGateFailure() {
  const review = await new ReviewEngine([], 'test').review(changeSetOf([]), workspaceOf({}));
  const initial = createMutationResult({ root: '/repo', authorized: true, impactedFiles: ['source.ts'], gatePolicy: { enabled: true, failOnDegradation: true } });
  let execution = initial.execution;
  for (const state of ['AWAITING_APPROVAL', 'QUEUED', 'RUNNING', 'COMPLETED'] as const) execution = transitionMutationExecution(execution, state, 'fixture');
  return { ...review, mutation: { ...initial, execution, verification: { status: 'FAIL' as const, reasons: ['demonstrated degradation'] }, gate: { decision: 'FAIL' as const, reasons: ['quality policy'] } } };
}

describe('independent CLI quality and execution decisions', () => {
  it('returns a quality failure even when ordinary finding thresholds are disabled', async () => {
    expect(reportExitCode(await reviewWithGateFailure(), 'none')).toBe(1);
  });
  it('preserves execution error precedence over a simultaneous quality failure', async () => {
    const review = await reviewWithGateFailure();
    expect(reportExitCode({ ...review, analyzerRuns: [{ analyzerId: 'fixture', status: 'failed' }] }, 'none')).toBe(2);
    expect(reportExitCode({ ...review, checks: [{ checkId: 'test', kind: 'test', label: 'test', commandLine: 'node test.cjs', status: 'timed-out', attribution: 'inconclusive', attributionNote: 'timeout' }] }, 'none')).toBe(2);
  });
  it('never returns success for cancelled or inconclusive explicitly requested mutation execution', async () => {
    const review = await reviewWithGateFailure();
    const execution = { ...review.mutation.execution, status: 'CANCELLED' as const };
    expect(reportExitCode({ ...review, mutation: { ...review.mutation, execution, gate: { decision: 'SKIP', reasons: ['disabled'] }, verification: { status: 'INCONCLUSIVE', reasons: ['cancelled'] } } }, 'none')).toBe(2);
    expect(reportExitCode({ ...review, mutation: { ...review.mutation, gate: { decision: 'SKIP', reasons: ['disabled'] }, verification: { status: 'INCONCLUSIVE', reasons: ['timeout'] } } }, 'none')).toBe(2);
  });
  it('requires explicit mutation authorization before accepting limits or differential flags', () => {
    expect(() => parseCliArgs(['--mutation-baseline'])).toThrow(/authorization/);
    expect(() => parseCliArgs(['--mutation-memory', '1024'])).toThrow(/authorization/);
    expect(parseCliArgs(['--mutation', '--mutation-baseline', '--mutation-gate', '--mutation-fail-on-degradation'])).toMatchObject({ mutation: true, mutationBaseline: true, mutationGate: true, mutationFailOnDegradation: true });
  });
  it('fails closed on an invalid repository policy instead of silently disabling its gate', async () => {
    const fixture = tempDir('probato-invalid-policy-');
    try {
      initRepo(fixture.dir, { 'source.ts': 'export const number = 1;', '.probato.yml': 'version: 1\nmutation: { enabled: true, arbitraryCommand: forbidden }\n' });
      let error = '';
      const exit = await runCli(['--root', fixture.dir, '--mutation', '--mutation-baseline', '--format', 'json'], { stdout: () => undefined, stderr: (message) => { error += message; } });
      expect(exit).toBe(2);
      expect(error).toContain('Invalid repository policy prevents a reliable CLI quality gate');
    } finally { fixture.cleanup(); }
  });
});
