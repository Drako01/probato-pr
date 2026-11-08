import { describe, expect, it } from 'vitest';
import type { PlannedCheck } from '../../src/core/model';
import { parseRepositoryPolicy } from '../../src/core/repository-policy';
import { mutationRunConfig } from '../../src/mutation/run-config';
import { rankChecks, recommendChecks } from '../../src/verification/check-impact';

function check(id: string, cwd: string): PlannedCheck { return { id, cwd, kind: 'test', label: id, command: { executable: 'node', args: ['test.cjs'] }, rationale: 'test', warnings: [], requires: [], outputFormat: 'plain', runsRepositoryCode: true, fingerprint: id }; }
const plan = [check('packages/a:script:test', 'packages/a'), check('packages/b:script:test', 'packages/b')];
describe('explainable check impact recommendations', () => {
  it('prioritizes the changed project while retaining every unrelated check', () => {
    const advice = recommendChecks(plan, ['packages/a/src/file.ts']);
    expect(advice.fallback).toBe(false);
    expect(advice.recommendations.map((item) => [item.checkId, item.confidence])).toEqual([[plan[0]?.id, 'medium'], [plan[1]?.id, 'low']]);
    expect(plan[0]?.command).toEqual({ executable: 'node', args: ['test.cjs'] });
  });
  it('maps repository paths only to an already detected check', () => {
    const policy = parseRepositoryPolicy('version: 1\nchecks: {recommendations: [{paths: ["shared/**"], checkIds: ["packages/b:script:test"]}]}');
    expect(recommendChecks(plan, ['shared/api.ts'], policy).recommendations[1]).toMatchObject({ confidence: 'high', checkId: plan[1]?.id });
  });
  it.each([[], ['pnpm-lock.yaml'], ['shared/unknown.ts'], ['../escape.ts'], ['/absolute.ts']].map((files) => ({ files })))('falls back to the entire plan for $files', ({ files }) => {
    const advice = recommendChecks(plan, files);
    expect(advice.fallback).toBe(true);
    expect(advice.recommendations.map((item) => item.checkId)).toEqual(plan.map((item) => item.id));
  });
  it('does not accept an unknown policy check ID as execution authority', () => {
    const policy = parseRepositoryPolicy('version: 1\nchecks: {recommendations: [{paths: ["**"], checkIds: ["unapproved:command"]}]}');
    const advice = recommendChecks(plan, ['packages/a/test.ts'], policy);
    expect(advice.fallback).toBe(true);
    expect(advice.recommendations.every((item) => item.confidence === 'low')).toBe(true);
    expect(advice.recommendations.some((item) => item.checkId === 'unapproved:command')).toBe(false);
  });
  it('ranks the whole plan by confidence without dropping or reordering ties', () => {
    const wide = [check('packages/c:script:test', 'packages/c'), ...plan, check('packages/d:script:test', 'packages/d')];
    const policy = parseRepositoryPolicy('version: 1\nchecks: {recommendations: [{paths: ["shared/**"], checkIds: ["packages/d:script:test"]}]}');
    const ranked = rankChecks(wide, ['packages/b/x.ts', 'shared/y.ts'], policy);
    expect(ranked.map((item) => [item.check.id, item.recommendation?.confidence])).toEqual([
      ['packages/d:script:test', 'high'], ['packages/b:script:test', 'medium'], ['packages/c:script:test', 'low'], ['packages/a:script:test', 'low'],
    ]);
    expect(rankChecks(wide, []).map((item) => item.check.id)).toEqual(wide.map((item) => item.id));
    expect(rankChecks([], ['a.ts'])).toEqual([]);
  });
});

describe('mutation run configuration', () => {
  const settings = { timeoutSeconds: 30, concurrency: 2, memoryMb: 512, maxFiles: 5, gateEnabled: false, failOnDegradation: false, minimumScore: 10, tolerancePoints: 1 };
  it('takes resource limits from the user and the gate from settings when no policy exists', () => {
    expect(mutationRunConfig(settings)).toEqual({
      limits: { timeoutMs: 30_000, concurrency: 2, memoryMb: 512, maxFiles: 5 },
      gatePolicy: { enabled: false, failOnDegradation: false, minimumScore: 10, tolerancePoints: 1 },
    });
  });
  it('lets a repository policy override only the gate fields it declares, never the resource budget', () => {
    const policy = parseRepositoryPolicy('version: 1\nmutation: {enabled: true, minimumScore: 80}').mutation;
    const config = mutationRunConfig(settings, policy);
    expect(config.gatePolicy).toEqual({ enabled: true, failOnDegradation: false, minimumScore: 80, tolerancePoints: 1 });
    expect(config.limits).toEqual(mutationRunConfig(settings).limits);
  });
});
