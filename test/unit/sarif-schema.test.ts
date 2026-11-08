import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewResult, Severity } from '../../src/core/model';
import { evaluateQualityGate } from '../../src/core/quality-gate';
import { ReviewEngine } from '../../src/core/review-engine';
import { renderJson } from '../../src/reports/json';
import { renderSarif } from '../../src/reports/sarif';
import { importSarif } from '../../src/reports/sarif-import';
import { changeSetOf, workspaceOf } from './helpers';

// Official OASIS SARIF 2.1.0 schema (draft-04), vendored unmodified from
// https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json
// The digest pins the vendored copy so an accidental edit cannot weaken the validation.
const SCHEMA_PATH = fileURLToPath(new URL('../fixtures/sarif/sarif-schema-2.1.0.json', import.meta.url));
const SCHEMA_SHA256 = 'c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e';
const schemaText = readFileSync(SCHEMA_PATH, 'utf8');

const isUri = (value: string): boolean => URL.canParse(value);
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('uri', isUri);
ajv.addFormat('uri-reference', (value: string) => isUri(value) || URL.canParse(value, 'file:///base/'));
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)));
const validate = ajv.compile(JSON.parse(schemaText) as object);

const SECRET = `AKIA${'Q'.repeat(16)}`;
const base = await new ReviewEngine([], 'test').review(changeSetOf([]), workspaceOf({}));
const finding = (ruleId: string, severity: Severity, file: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({ id: `${ruleId}:${file}:${severity}`, ruleId, severity, verification: 'evidenced', verificationNote: 'note', origin: 'analyzer', title: 'title', description: 'description', location: { file, startLine: 3, endLine: 4 }, evidence: [], ...extra });

const FIXTURES: Readonly<Record<string, ReviewResult>> = {
  'empty review': base,
  'mixed security and quality rules': { ...base, repository: { ...base.repository, root: '/repo' }, findings: [
    finding('secrets/aws-access-key', 'critical', 'src/config.ts', { attribution: 'introduced', suggestedFix: 'Rotate the key' }),
    finding('tests/skipped', 'low', 'test/a.test.ts', { attribution: 'pre-existing', verification: 'suspected' }),
    finding('contracts/export-removed', 'high', 'src/api.ts', { origin: 'verification', attribution: 'fixed' }),
    finding('ai/review', 'medium', 'src/api.ts', { origin: 'ai', verification: 'not-verified' }),
    finding('external/eslint/no-unused-vars', 'medium', 'src/b.ts'),
  ] },
  'paths that need URI encoding and a Windows root': { ...base, repository: { ...base.repository, root: 'C:\\work\\my repo' }, findings: [
    finding('errors/empty-catch', 'medium', 'src/dir with spaces/ñandú #1%.ts'),
    finding('errors/empty-catch', 'high', 'src/[id]/page.tsx', { location: { file: 'src/[id]/page.tsx', startLine: 0 } }),
  ] },
  'failed analyzer and checks': { ...base, analyzerRuns: [{ analyzerId: 'fixture', status: 'failed' }], checks: [{ checkId: 'test', kind: 'test', label: 'test', commandLine: 'pnpm test', status: 'failed', attribution: 'inconclusive', attributionNote: 'no baseline' }] },
  'secret in human-readable text': { ...base, findings: [finding('tests/focused', 'medium', 'a.ts', { title: `uses ${SECRET}`, description: `token=${SECRET}` })] },
};

const parse = (text: string): { runs: [{ results: { partialFingerprints: Record<string, string>; locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[]; properties: Record<string, unknown>; tool: { driver: { rules: { properties: Record<string, unknown> }[] } } }] } => JSON.parse(text) as never;

describe('SARIF 2.1.0 schema conformance', () => {
  it('validates against an unmodified copy of the official OASIS schema', () => {
    // Line endings are normalized so a Git autocrlf checkout does not change the digest.
    expect(createHash('sha256').update(schemaText.replaceAll('\r\n', '\n')).digest('hex')).toBe(SCHEMA_SHA256);
  });

  it.each(Object.entries(FIXTURES))('%s produces a schema-valid report, with and without a gate decision', (_, review) => {
    for (const gate of [undefined, evaluateQualityGate(review, { mode: 'hybrid', threshold: 'medium', inconclusive: 'warn' })]) {
      const valid = validate(JSON.parse(renderSarif(review, gate)));
      expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
      expect(valid).toBe(true);
    }
  });

  it('meets the GitHub code scanning upload constraints used by the fixtures', () => {
    for (const review of Object.values(FIXTURES)) {
      const run = parse(renderSarif(review)).runs[0];
      for (const result of run.results) {
        const uri = result.locations[0]?.physicalLocation.artifactLocation.uri ?? '';
        expect(uri.startsWith('/') || /^[a-z]+:/i.test(uri), uri).toBe(false);
        expect(Object.keys(result.partialFingerprints)).toEqual(['probatoFindingId/v1']);
      }
      for (const rule of run.tool.driver.rules) {
        const score = rule.properties['security-severity'];
        if (score !== undefined) expect(Number(score)).toBeGreaterThanOrEqual(0);
        if (score !== undefined) expect(Number(score)).toBeLessThanOrEqual(10);
      }
    }
  });

  it('keeps fingerprints stable across renders and independent of finding order', () => {
    const review = FIXTURES['mixed security and quality rules'];
    if (!review) throw new Error('fixture missing');
    const prints = (r: ReviewResult) => parse(renderSarif(r)).runs[0].results.map((result) => result.partialFingerprints['probatoFindingId/v1']).sort();
    expect(prints(review)).toEqual(prints(review));
    expect(prints({ ...review, findings: [...review.findings].reverse() })).toEqual(prints(review));
  });

  it('never exports secrets present in human-readable finding text', () => {
    const review = FIXTURES['secret in human-readable text'];
    if (!review) throw new Error('fixture missing');
    expect(renderSarif(review)).not.toContain(SECRET);
    expect(renderJson(review)).not.toContain(SECRET);
  });

  it('round-trips through the SARIF importer as unverified external evidence', () => {
    const review = FIXTURES['paths that need URI encoding and a Windows root'];
    if (!review) throw new Error('fixture missing');
    const target = { ...base, changedFiles: review.findings.map((f) => f.location.file) };
    const imported = importSarif(renderSarif(review), target);
    expect(imported.findings.map((f) => f.location.file).sort()).toEqual([...target.changedFiles].sort());
    expect(imported.findings.every((f) => f.verification === 'evidenced' && f.attribution === 'unknown')).toBe(true);
  });
});

describe('quality gate decision in machine-readable reports', () => {
  const warned = { ...base, findings: [finding('tests/skipped', 'high', 'a.ts', { attribution: 'pre-existing' }), finding('ai/review', 'high', 'b.ts', { verification: 'suspected', attribution: 'introduced' })] };
  const decision = evaluateQualityGate(warned, { mode: 'regression-only', threshold: 'high', inconclusive: 'warn' });

  it('exposes a WARN decision instead of hiding it behind exit code 0', () => {
    expect(decision).toMatchObject({ outcome: 'WARN', exitCode: 0 });
    expect((JSON.parse(renderJson(warned, undefined, decision)) as { qualityGate: unknown }).qualityGate).toEqual(decision);
    expect(parse(renderSarif(warned, decision)).runs[0].properties.qualityGate).toEqual(decision);
  });

  it('omits the field when no decision is passed (absolute mode keeps the 0.6.0 report shape)', () => {
    expect(renderJson(warned)).not.toContain('qualityGate');
    expect(renderSarif(warned)).not.toContain('qualityGate');
  });
});
