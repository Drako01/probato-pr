import { describe, expect, it } from 'vitest';
import { parseCliArgs, reportExitCode } from '../../src/cli';
import type { Attribution, CheckResult, ReviewFinding, ReviewResult, Severity, VerificationStatus } from '../../src/core/model';
import { ReviewEngine } from '../../src/core/review-engine';
import { evaluateQualityGate, GATE_MODES, type GateMode, type InconclusivePolicy } from '../../src/core/quality-gate';
import { changeSetOf, workspaceOf } from './helpers';

const base = await new ReviewEngine([], 'test').review(changeSetOf([]), workspaceOf({}));

function finding(severity: Severity, verification: VerificationStatus, attribution?: Attribution): ReviewFinding {
  return { id: `${severity}-${verification}-${attribution ?? 'none'}`, ruleId: 'contracts/export-removed', severity, verification, verificationNote: 'n', origin: 'analyzer', title: 't', description: 'd', location: { file: 'a.ts', startLine: 1 }, evidence: [], ...(attribution ? { attribution } : {}) };
}
function check(status: CheckResult['status'], attribution: Attribution): CheckResult {
  return { checkId: `test-${attribution}`, kind: 'test', label: 'test', commandLine: 'node test.cjs', status, attribution, attributionNote: 'fixture' };
}
const reviewOf = (findings: ReviewFinding[] = [], checks: CheckResult[] = []): ReviewResult => ({ ...base, findings, checks });
const gate = (review: ReviewResult, mode: GateMode, inconclusive: InconclusivePolicy = 'fail', threshold: Severity | 'none' = 'high') => evaluateQualityGate(review, { mode, threshold, inconclusive });

describe('quality gate truth table', () => {
  // [description, review, mode, inconclusive policy, expected outcome, expected exit code]
  const table: readonly [string, ReviewResult, GateMode, InconclusivePolicy, string, number][] = [
    ['clean review', reviewOf(), 'absolute', 'fail', 'PASS', 0],
    ['clean review', reviewOf(), 'regression-only', 'fail', 'PASS', 0],
    ['clean review', reviewOf(), 'hybrid', 'fail', 'PASS', 0],
    ['execution error', reviewOf([], [check('error', 'unknown')]), 'absolute', 'fail', 'INCOMPLETE', 2],
    ['execution error', reviewOf([], [check('timed-out', 'unknown')]), 'regression-only', 'warn', 'INCOMPLETE', 2],
    ['execution error outranks a demonstrated failure', reviewOf([], [check('cancelled', 'unknown'), check('failed', 'introduced')]), 'hybrid', 'warn', 'INCOMPLETE', 2],
    ['introduced check failure', reviewOf([], [check('failed', 'introduced')]), 'absolute', 'fail', 'FAIL', 1],
    ['introduced check failure', reviewOf([], [check('failed', 'introduced')]), 'regression-only', 'fail', 'FAIL', 1],
    ['introduced check failure', reviewOf([], [check('failed', 'introduced')]), 'hybrid', 'warn', 'FAIL', 1],
    ['pre-existing check failure', reviewOf([], [check('failed', 'pre-existing')]), 'absolute', 'fail', 'FAIL', 1],
    ['pre-existing check failure', reviewOf([], [check('failed', 'pre-existing')]), 'regression-only', 'fail', 'WARN', 0],
    ['pre-existing check failure', reviewOf([], [check('failed', 'pre-existing')]), 'hybrid', 'fail', 'WARN', 0],
    ['unattributed check failure', reviewOf([], [check('failed', 'unknown')]), 'absolute', 'fail', 'FAIL', 1],
    ['unattributed check failure', reviewOf([], [check('failed', 'unknown')]), 'regression-only', 'fail', 'INCOMPLETE', 2],
    ['unattributed check failure', reviewOf([], [check('failed', 'inconclusive')]), 'regression-only', 'warn', 'WARN', 0],
    ['unattributed check failure', reviewOf([], [check('failed', 'inconclusive')]), 'hybrid', 'fail', 'INCOMPLETE', 2],
    ['demonstrated failure outranks missing attribution', reviewOf([], [check('failed', 'introduced'), check('failed', 'unknown')]), 'regression-only', 'fail', 'FAIL', 1],
    ['suspected high finding', reviewOf([finding('high', 'suspected')]), 'absolute', 'fail', 'FAIL', 1],
    ['suspected high finding', reviewOf([finding('high', 'suspected', 'introduced')]), 'regression-only', 'fail', 'WARN', 0],
    ['suspected high finding', reviewOf([finding('high', 'suspected')]), 'hybrid', 'fail', 'WARN', 0],
    ['evidenced high finding without attribution', reviewOf([finding('high', 'evidenced')]), 'regression-only', 'fail', 'WARN', 0],
    ['evidenced high finding without attribution', reviewOf([finding('high', 'evidenced')]), 'hybrid', 'fail', 'FAIL', 1],
    ['evidenced introduced finding', reviewOf([finding('high', 'evidenced', 'introduced')]), 'regression-only', 'fail', 'FAIL', 1],
    ['confirmed pre-existing finding', reviewOf([finding('critical', 'confirmed', 'pre-existing')]), 'absolute', 'fail', 'FAIL', 1],
    ['confirmed pre-existing finding', reviewOf([finding('critical', 'confirmed', 'pre-existing')]), 'regression-only', 'fail', 'PASS', 0],
    ['confirmed pre-existing finding', reviewOf([finding('critical', 'confirmed', 'pre-existing')]), 'hybrid', 'fail', 'PASS', 0],
    ['not-verified introduced finding', reviewOf([finding('high', 'not-verified', 'introduced')]), 'hybrid', 'fail', 'WARN', 0],
    ['finding below threshold', reviewOf([finding('medium', 'confirmed', 'introduced')]), 'regression-only', 'fail', 'PASS', 0],
  ];
  it.each(table)('%s — %s/%s', (_name, review, mode, inconclusive, outcome, exitCode) => {
    const decision = gate(review, mode, inconclusive);
    expect(decision).toMatchObject({ mode, outcome, exitCode });
    if (outcome !== 'PASS') expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('never reports PASS for a failed check without comparable baseline, whatever the mode or policy', () => {
    for (const mode of GATE_MODES) {
      for (const policy of ['fail', 'warn'] as const) expect(gate(reviewOf([], [check('failed', 'unknown')]), mode, policy).outcome).not.toBe('PASS');
    }
  });

  it('keeps the 0.6.0 reportExitCode contract identical to the absolute mode', () => {
    for (const [, review] of table) {
      for (const threshold of ['critical', 'high', 'medium', 'low', 'none'] as const) {
        expect(reportExitCode(review, threshold)).toBe(gate(review, 'absolute', 'fail', threshold).exitCode);
      }
    }
  });

  it('exposes the gate options additively in the CLI with backward compatible defaults', () => {
    expect(parseCliArgs([])).toMatchObject({ gate: 'absolute', onInconclusive: 'fail', failOn: 'high' });
    expect(parseCliArgs(['--gate', 'regression-only', '--on-inconclusive', 'warn'])).toMatchObject({ gate: 'regression-only', onInconclusive: 'warn' });
    expect(() => parseCliArgs(['--gate', 'strict'])).toThrow(/gate mode/);
    expect(() => parseCliArgs(['--gate', 'hybrid', '--on-inconclusive', 'ignore'])).toThrow(/inconclusive policy/);
    expect(() => parseCliArgs(['--on-inconclusive', 'warn'])).toThrow(/regression-only and hybrid/);
  });
});
