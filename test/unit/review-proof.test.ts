import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { explainFinding } from '../../src/core/finding-explanation';
import { compareReviews } from '../../src/core/review-comparison';
import type { ReviewFinding, ReviewResult } from '../../src/core/model';
import { assessRisk } from '../../src/core/risk';
import { HistoryStore } from '../../src/infrastructure/history-store';
import { readStoredReview } from '../../src/infrastructure/history-schema';
import { tempDir } from './helpers';

function finding(id: string, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { id, ruleId: 'rule', origin: 'analyzer', title: id, description: 'Observed code changed', location: { file: 'src/api.ts', startLine: 3 }, evidence: [{ evidenceId: `ev-${id}`, summary: 'Inspected source' }], severity: 'high', verification: 'evidenced', verificationNote: 'Static inspection only', ...overrides };
}
function review(id: string, findings: readonly ReviewFinding[] = []): ReviewResult {
  const scope = { kind: 'working' as const, label: 'Working changes', baseSha: 'a'.repeat(40), headIsWorkingTree: true };
  return { id, createdAt: '2026-11-03T12:00:00Z', toolVersion: 'test', snapshot: 'c'.repeat(64), scope,
    repository: { name: 'repo', root: '/repo', branch: 'feature', headSha: 'b'.repeat(40) },
    stats: { filesChanged: 1, filesSkipped: 0, additions: 1, deletions: 1 }, changedFiles: ['src/api.ts'], skipped: [], findings,
    evidence: findings.map((f) => ({ kind: 'static-analysis', id: `ev-${f.id}`, analyzerId: 'analyzer', description: f.description, locations: [f.location] })),
    checks: [], analyzerRuns: [{ analyzerId: 'analyzer', status: 'ran' }], aiRuns: [], risk: assessRisk({ findings, checks: [], analyzerRuns: [{ analyzerId: 'analyzer', status: 'ran' }], scope, skipped: [] }),
  };
}

describe('evidence-driven finding explanation', () => {
  it('shows only explicit evidence relationships, including cross-file locations', () => {
    const f = finding('cross-file');
    const initial = review('r', [f]);
    const source: ReviewResult = { ...initial, evidence: [{ kind: 'static-analysis', id: 'ev-cross-file', analyzerId: 'analyzer', description: 'Exact relation', locations: [f.location, { file: 'src/consumer.ts', startLine: 9 }] }], checks: [{ checkId: 'unrelated', kind: 'test', label: 'Other check', commandLine: 'test', status: 'failed', headEvidenceId: 'different-evidence', attribution: 'introduced', attributionNote: 'Other failure' }] };
    const explanation = explainFinding(source, f);
    expect(explanation.evidence[0]?.locations).toEqual([f.location, { file: 'src/consumer.ts', startLine: 9 }]);
    expect(explanation.checks).toEqual([]);
    expect(explanation.missingProof.join(' ')).toContain('No executed check is explicitly linked');
  });

  it('does not turn AI hypotheses or broken references into observed proof', () => {
    const f = finding('ai', { origin: 'ai', verification: 'suspected', evidence: [{ evidenceId: 'absent', summary: 'Claim' }] });
    const explanation = explainFinding(review('r'), f);
    expect(explanation.evidence[0]?.available).toBe(false);
    expect(explanation.observationNote).toContain('hypothesis');
    expect(explanation.missingProof.join(' ')).toContain('unavailable');
    expect(explanation.missingProof.join(' ')).toContain('do not prove a defect');
  });
});

describe('review comparison', () => {
  it('matches shifted findings by semantic identity, keeps duplicate counts, and reports unproven disappearance', () => {
    const previous = review('old', [finding('same'), finding('shifted', { title: 'Unchanged title' }), finding('gone'), finding('duplicate', { title: 'Duplicate' }), finding('duplicate2', { title: 'Duplicate' })]);
    const current = review('new', [finding('same'), finding('shifted-new-id', { title: 'Unchanged title', location: { file: 'src/api.ts', startLine: 30 } }), finding('fresh'), finding('dup3', { title: 'Duplicate' })]);
    const result = compareReviews(previous, current);
    expect(result.comparable).toBe(true);
    expect(result.counts).toEqual({ new: 1, persisting: 3, 'no-longer-observed': 2 });
    expect(result.entries.filter((entry) => entry.status === 'no-longer-observed').every((entry) => entry.note.includes('without proof of resolution'))).toBe(true);
  });

  it('keeps stable finding identity across translated titles without merging unrelated same-rule findings', () => {
    const previous = review('old', [finding('stable', { title: 'Removed export' }), finding('old-other', { title: 'Removed enum member' })]);
    const current = review('new', [finding('stable', { title: 'Exportación eliminada' }), finding('new-other', { title: 'New required parameter' })]);
    const comparison = compareReviews(previous, current);
    expect(comparison.counts).toEqual({ new: 1, persisting: 1, 'no-longer-observed': 1 });
    expect(comparison.entries.find((entry) => entry.current?.id === 'stable')?.status).toBe('persisting');
    expect(comparison.entries.find((entry) => entry.current?.id === 'new-other')?.status).toBe('new');
  });

  it.each(['repository', 'scope', 'base', 'branch', 'target', 'unknown-base', 'pull-request'] as const)('fails closed for incomparable %s identity', (difference) => {
    const previous = review('old');
    let current = review('new');
    if (difference === 'repository') current = { ...current, repository: { ...current.repository, root: '/elsewhere' } };
    if (difference === 'scope') current = { ...current, scope: { ...current.scope, kind: 'staged' } };
    if (difference === 'base') current = { ...current, scope: { ...current.scope, baseSha: 'd'.repeat(40) } };
    if (difference === 'branch') current = { ...current, repository: { ...current.repository, branch: 'other' } };
    if (difference === 'target') current = { ...current, scope: { ...current.scope, headRef: 'other' } };
    if (difference === 'unknown-base') current = { ...current, scope: { kind: 'working', label: 'Working changes', headIsWorkingTree: true } };
    if (difference === 'pull-request') current = { ...current, scope: { ...current.scope, pullRequest: { owner: 'owner', repo: 'repo', number: 3, url: 'https://github.com/owner/repo/pull/3' } } };
    const result = compareReviews(previous, current);
    expect(result.comparable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.reason).toBeTruthy();
  });

  it('does not claim resolution when an explicitly linked check now passes', () => {
    const f = finding('diagnostic');
    const old = review('old', [f]);
    const previous: ReviewResult = { ...old, checks: [{ checkId: 'tsc', kind: 'typecheck', label: 'tsc', commandLine: 'tsc --noEmit', status: 'failed', headEvidenceId: 'ev-diagnostic', attribution: 'introduced', attributionNote: 'Failed on head' }] };
    const next = review('new');
    const current: ReviewResult = { ...next, checks: [{ checkId: 'tsc', kind: 'typecheck', label: 'tsc', commandLine: 'tsc --noEmit', status: 'passed', headEvidenceId: 'passed-tsc', attribution: 'unknown', attributionNote: 'Passed on head' }], evidence: [{ kind: 'command-run', id: 'passed-tsc', checkId: 'tsc', revision: 'head', commitSha: next.repository.headSha, dirty: true, commandLine: 'tsc --noEmit', cwd: '', startedAt: next.createdAt, durationMs: 100, outcome: 'passed', exitCode: 0, signal: null, outputExcerpt: '', outputTruncated: false, outputSha256: 'e'.repeat(64) }] };
    const entry = compareReviews(previous, current).entries[0];
    expect(entry?.status).toBe('no-longer-observed');
    expect(entry?.passedCheckEvidenceId).toBe('passed-tsc');
    expect(entry?.note).toContain('does not prove');
  });
});

describe('bounded versioned review history', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { cleanups.splice(0).forEach((cleanup) => { cleanup(); }); });
  function storage() { const temporary = tempDir(); cleanups.push(temporary.cleanup); return temporary; }

  it('migrates valid legacy reviews, keeps summaries, and rejects invalid full records', async () => {
    const { dir } = storage();
    const previous = review('old', [finding('old')]);
    writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ version: 1, latest: { review: previous }, history: [{ id: 'old', createdAt: previous.createdAt, repository: 'repo', scope: 'Working changes', risk: 'high', findings: 1 }] }));
    const store = new HistoryStore(dir);
    expect((await store.load()).snapshots[0]?.id).toBe('old');
    expect((await store.load()).history[0]?.snapshotAvailable).toBe(true);
    expect(readStoredReview({ ...previous, evidence: [{ kind: 'command-run', id: 'invalid' }] })).toBeUndefined();
    writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ version: 2, latest: { review: { ...previous, findings: [{}] } }, history: [], snapshots: [previous, { ...previous, id: 'bad', snapshot: 'invalid' }] }));
    const stored = await store.load();
    expect(stored.latest).toBeUndefined();
    expect(stored.snapshots.map((snapshot) => snapshot.id)).toEqual(['old']);
  });

  it('retains twenty summaries and at most five sanitized full reviews', async () => {
    const { dir } = storage();
    const store = new HistoryStore(dir);
    for (let index = 0; index < 23; index++) await store.save(review(`r${index}`, [finding(`f${index}`)]), undefined);
    const stored = await store.load();
    expect(stored.version).toBe(2);
    expect(stored.history).toHaveLength(20);
    expect(stored.snapshots).toHaveLength(5);
    expect(stored.history.filter((entry) => entry.snapshotAvailable)).toHaveLength(5);
    expect(await store.findReview('r0')).toBeUndefined();
    expect((await store.findReview('r22'))?.id).toBe('r22');
    expect(Buffer.byteLength(readFileSync(path.join(dir, 'reviews.json'), 'utf8'))).toBeLessThan(10_000_000);
  });

  it('never returns mismatched verified state or oversized snapshots as current', async () => {
    const { dir } = storage();
    const current = review('current');
    writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ version: 2, latest: { review: current, verified: { ...current, id: 'other' } }, history: [], snapshots: [] }));
    const store = new HistoryStore(dir);
    expect((await store.load()).latest?.verified).toBeUndefined();
    writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ version: 2, latest: { review: current, verified: { ...current, scope: { ...current.scope, headSha: 'f'.repeat(40) } } }, history: [], snapshots: [] }));
    expect((await store.load()).latest?.verified).toBeUndefined();
    expect(readStoredReview({ ...current, performance: { analysisMs: -1, analyzers: [] } })).toBeUndefined();
    expect(readStoredReview({ ...current, reproducibility: [{ checkId: 'x', status: 'comparable', reasons: 'not-an-array' }] })).toBeUndefined();
    const huge = { ...current, id: 'huge', aiSummary: { author: 'AI', overview: 'x'.repeat(1_600_000), changes: [], reviewFocus: [] } };
    await store.save(huge, undefined);
    expect(await store.findReview('huge')).toBeUndefined();
    writeFileSync(path.join(dir, 'reviews.json'), ' '.repeat(10_000_001));
    expect((await store.load()).latest).toBeUndefined();
  });
});
