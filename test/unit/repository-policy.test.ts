import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRepositoryPolicy, applyReviewPolicy } from '../../src/core/repository-policy';
import type { ReviewFinding, ReviewResult } from '../../src/core/model';
import { finalizeResult } from '../../src/core/review-engine';
import { loadRepositoryPolicy } from '../../src/infrastructure/repository-policy';
import { tempDir, workspaceOf } from './helpers';

function result(findings: readonly ReviewFinding[]): ReviewResult {
  return finalizeResult({ id: 'r', createdAt: '2026-11-03T00:00:00Z', toolVersion: 'test', scope: { kind: 'working', label: 'working', headIsWorkingTree: true }, repository: { name: 'r', root: '/r', branch: 'main', headSha: undefined }, stats: { filesChanged: 1, filesSkipped: 0, additions: 1, deletions: 0 }, changedFiles: ['a.ts'], skipped: [], findings, evidence: [], checks: [], analyzerRuns: [], aiRuns: [] });
}
function finding(ruleId: string, severity: ReviewFinding['severity']): ReviewFinding {
  return { id: ruleId, ruleId, severity, verification: 'suspected', verificationNote: 'unproven', origin: 'analyzer', title: ruleId, description: 'description', location: { file: 'a.ts', startLine: 1 }, evidence: [] };
}

describe('versioned repository policy', () => {
  it('accepts only bounded declarative overrides and references to existing checks', () => {
    expect(parseRepositoryPolicy('version: 1\nreview:\n  severityOverrides:\n    contracts/export-removed: high\nchecks:\n  recommendations:\n    - paths: ["src/**"]\n      checkIds: ["script:test"]\n')).toMatchObject({ version: 1, checks: { recommendations: [{ paths: ['src/**'], checkIds: ['script:test'] }] } });
  });
  it.each([
    'version: 2', 'version: 1\ncommands: ["curl evil"]', 'version: 1\napprovals: true',
    'version: 1\nreview: {exclude: ["**"]}', 'version: 1\nreview: {minSeverity: critical}',
    'version: 1\nreview: {severityOverrides: {constructor: low}}',
    'version: 1\nchecks: {recommendations: [{paths: ["../outside"], checkIds: ["script:test"]}]}',
    'version: 1\nversion: 1', 'version: !!js/function "run()"', 'version: &v 1\nreview: *v',
  ])('rejects unsafe or unsupported policy %s', (text) => { expect(() => parseRepositoryPolicy(text)).toThrow(/Invalid .probato.yml/); });
  it('accepts declarative mutation gates without granting execution approval or changing check commands', () => {
    const policy = parseRepositoryPolicy('version: 1\nmutation: {enabled: true, failOnDegradation: true, minimumScore: 75, tolerancePoints: 0}');
    expect(policy.mutation).toEqual({ enabled: true, failOnDegradation: true, minimumScore: 75, tolerancePoints: 0 });
    expect(() => parseRepositoryPolicy('version: 1\nmutation: {enabled: true, approved: true}')).toThrow(/Invalid .probato.yml/);
    expect(() => parseRepositoryPolicy('version: 1\nmutation: {minimumScore: 101}')).toThrow(/Invalid .probato.yml/);
    expect(() => parseRepositoryPolicy('version: 1\nmutation: {tolerancePoints: -1}')).toThrow(/Invalid .probato.yml/);
  });
  it('enforces the byte bound before parsing', () => { expect(() => parseRepositoryPolicy(' '.repeat(65_537))).toThrow(/limit/); });
  it('retains findings and verification strength while disclosing severity changes', () => {
    const before = result([finding('contracts/export-removed', 'medium')]);
    const after = applyReviewPolicy(before, parseRepositoryPolicy('version: 1\nreview: {severityOverrides: {contracts/export-removed: high}}'));
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]).toMatchObject({ severity: 'high', verification: 'suspected' });
    expect(after.risk.limitations.join('\n')).toMatch(/policy changed/);
    expect(after.policyNotes?.join('\n')).toMatch(/policy changed/);
    const recomputed = finalizeResult({ ...after, checks: [] });
    expect(recomputed.risk.limitations.join('\n')).toMatch(/policy changed/);
    expect(before.findings[0]?.severity).toBe('medium');
  });
  it('does not lower secrets or critical findings', () => {
    const before = result([finding('secrets/private-key', 'critical'), finding('secrets/token', 'high'), finding('contracts/export-removed', 'critical')]);
    const after = applyReviewPolicy(before, parseRepositoryPolicy('version: 1\nreview: {severityOverrides: {secrets/private-key: low, secrets/token: low, contracts/export-removed: low}}'));
    expect(after.findings.map((item) => [item.ruleId, item.severity])).toEqual(before.findings.map((item) => [item.ruleId, item.severity]));
    expect(after.risk.limitations.filter((item) => item.includes('protected finding'))).toHaveLength(3);
  });
  it('uses the exact revision index without falling back to working-tree policy', async () => {
    const dir = tempDir();
    try {
      await writeFile(path.join(dir.dir, '.probato.yml'), 'version: 2');
      expect(await loadRepositoryPolicy(dir.dir, workspaceOf({ '.probato.yml': 'version: 1' }))).toEqual({ policy: { version: 1 }, warnings: [] });
      expect(await loadRepositoryPolicy(dir.dir, workspaceOf({}))).toEqual({ warnings: [] });
      expect((await loadRepositoryPolicy(dir.dir)).warnings.join(' ')).toMatch(/not applied/);
    } finally { dir.cleanup(); }
  });
  it('warns when a versioned policy exists but its contents were omitted by a bounded index', async () => {
    const loaded = await loadRepositoryPolicy('/unused', { listFiles: () => Promise.resolve(['.probato.yml']), read: () => Promise.resolve(undefined) });
    expect(loaded.policy).toBeUndefined();
    expect(loaded.warnings.join(' ')).toMatch(/could not be read/);
  });
});
