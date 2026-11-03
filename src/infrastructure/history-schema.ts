import { z } from 'zod';
import { readStoredMutation } from './mutation-history-schema';
import type { ReviewResult } from '../core/model';

const text = z.string().max(2_000_000);
const id = z.string().min(1).max(2000);
const location = z.object({ file: text, startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).loose().refine((value) => value.endLine === undefined || value.endLine >= value.startLine);
const attribution = z.enum(['introduced', 'pre-existing', 'fixed', 'inconclusive', 'unknown']);
const checkStatus = z.enum(['passed', 'failed', 'timed-out', 'cancelled', 'error', 'pending']);
const evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('static-analysis'), id, analyzerId: text, description: text, locations: z.array(location).max(10_000), excerpt: text.optional() }).loose(),
  z.object({ kind: z.literal('command-run'), id, checkId: text, revision: z.enum(['base', 'head']), commitSha: text.optional(), dirty: z.boolean(), commandLine: text, cwd: text, startedAt: text, durationMs: z.number().nonnegative(), exitCode: z.number().int().nullable(), signal: text.nullable(), outcome: z.enum(['passed', 'failed', 'timed-out', 'cancelled', 'error']), outputExcerpt: text, outputTruncated: z.boolean(), outputSha256: text, errorMessage: text.optional() }).loose(),
]);
const count = z.number().int().nonnegative();
const review = z.object({
  performance: z.object({ analysisMs: z.number().nonnegative(), analyzers: z.array(z.object({ analyzerId: id, durationMs: z.number().nonnegative() })).max(1000) }).optional(),
  reproducibility: z.array(z.object({ checkId: id, status: z.enum(['comparable', 'inconclusive']), reasons: z.array(text).max(1000) })).max(10_000).optional(),
  policyNotes: z.array(text).max(1000).optional(),
  id, createdAt: text, toolVersion: text, snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scope: z.object({ kind: z.enum(['working', 'staged', 'branch', 'commit', 'pull-request']), label: text, baseRef: text.optional(), baseSha: text.optional(), headRef: text.optional(), headSha: text.optional(), headIsWorkingTree: z.boolean(), pullRequest: z.object({ owner: text, repo: text, number: z.number().int().positive(), url: text }).optional() }).loose(),
  repository: z.object({ name: text, root: text, branch: text.optional(), headSha: text.optional() }).loose(),
  stats: z.object({ filesChanged: count, filesSkipped: count, additions: count, deletions: count }).loose(),
  changedFiles: z.array(text).max(100_000), skipped: z.array(z.object({ path: text, reason: text })).max(100_000),
  findings: z.array(z.object({ id, ruleId: text, severity: z.enum(['critical', 'high', 'medium', 'low']), verification: z.enum(['confirmed', 'evidenced', 'suspected', 'not-verified']), verificationNote: text, origin: z.enum(['analyzer', 'verification', 'ai']), title: text, description: text, location, evidence: z.array(z.object({ evidenceId: id, summary: text })).max(10_000), attribution: attribution.optional(), suggestedFix: text.optional() }).loose()).max(10_000),
  evidence: z.array(evidence).max(20_000),
  checks: z.array(z.object({ checkId: text, kind: z.enum(['typecheck', 'lint', 'test', 'build', 'vet']), label: text, commandLine: text, status: checkStatus, headEvidenceId: text.optional(), baseEvidenceId: text.optional(), attribution, attributionNote: text }).loose()).max(10_000),
  analyzerRuns: z.array(z.object({ analyzerId: text, status: z.enum(['ran', 'skipped', 'failed']), detail: text.optional() }).loose()).max(1000),
  aiRuns: z.array(z.object({ providerId: text, model: text, startedAt: text, filesShared: z.array(text).max(100_000), accepted: count, rejected: count, rejectionReasons: z.array(text).max(10_000) }).loose()).max(1000),
  aiSummary: z.object({ author: text, overview: text, changes: z.array(z.object({ file: text, summary: text })).max(100_000), reviewFocus: z.array(text).max(10_000) }).loose().optional(),
  risk: z.object({ level: z.enum(['critical', 'high', 'medium', 'low', 'unknown']), reasons: z.array(text).max(10_000), limitations: z.array(text).max(10_000), counts: z.object({ byVerification: z.object({ confirmed: count, evidenced: count, suspected: count, 'not-verified': count }), bySeverity: z.object({ critical: count, high: count, medium: count, low: count }), checks: z.object({ passed: count, failed: count, notRun: count }), regressions: count }) }).loose(),
}).loose();

/** Persisted JSON is untrusted. Invalid records may remain summaries but cannot become review/evidence state. */
export function readStoredReview(value: unknown): ReviewResult | undefined {
  const parsed = review.safeParse(value);
  if (parsed.success && parsed.data.mutation !== undefined) {
    const mutation = readStoredMutation(parsed.data.mutation);
    if (!mutation) return undefined;
    parsed.data.mutation = mutation;
  }
  return parsed.success ? parsed.data as unknown as ReviewResult : undefined;
}
