import { z } from 'zod';
import { tr } from '../core/i18n';
import { stableId } from '../core/ids';
import type { AiSummary, ChangeSet, ReviewFinding } from '../core/model';
import { addedLines } from '../git/diff-parser';

const MAX_FINDINGS = 50;
const MAX_SUMMARY_ITEMS = 100;
/** Lines of tolerance around an added line; models often point at the statement start nearby. */
const LINE_TOLERANCE = 2;

const AiFindingSchema = z.object({
  file: z.string().min(1).max(500),
  line: z.number().int().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4000),
  suggestedFix: z.string().max(4000).optional(),
});
const AiSummarySchema = z.object({
  overview: z.string().min(1).max(4000),
  changes: z.array(z.object({ file: z.string().min(1).max(500), summary: z.string().min(1).max(1000) })).max(500).default([]),
  reviewFocus: z.array(z.string().min(1).max(1000)).max(50).default([]),
});
const AiResponseSchema = z.object({ findings: z.array(z.unknown()).max(500), summary: z.unknown().optional() });

export interface ParsedAiReview {
  readonly accepted: readonly ReviewFinding[];
  readonly rejected: readonly string[];
  /** Absent when the model sent none or it was malformed (then a rejection explains why). */
  readonly summary?: AiSummary;
}

const normalizePath = (file: string): string => file.replace(/^\.?\//, '');

/** Keeps the walkthrough to files that were shared; descriptions of anything else are dropped. */
function parseSummary(raw: unknown, shared: ReadonlySet<string>, author: string, rejected: string[]): AiSummary | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = AiSummarySchema.safeParse(raw);
  if (!parsed.success) {
    rejected.push('Summary did not match the expected shape and was ignored.');
    return undefined;
  }
  const changes = parsed.data.changes.map((c) => ({ file: normalizePath(c.file), summary: c.summary }));
  const unknown = changes.filter((c) => !shared.has(c.file));
  if (unknown.length > 0) {
    rejected.push(`Summary entries for ${unknown.length} file(s) that were not shared were ignored.`);
  }
  return {
    author,
    overview: parsed.data.overview,
    changes: changes.filter((c) => shared.has(c.file)).slice(0, MAX_SUMMARY_ITEMS),
    reviewFocus: parsed.data.reviewFocus,
  };
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/**
 * Validates an AI response against the reviewed change. A finding is accepted only if it points at
 * a file that was shared and at (or next to) a line the change added; everything else is rejected
 * with a reason. Accepted findings are always "suspected": an AI claim is not proof.
 */
export function parseAiReview(text: string, changes: ChangeSet, sharedFiles: readonly string[], providerLabel: string): ParsedAiReview {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { accepted: [], rejected: ['Response was not valid JSON.'] };
  }
  const envelope = AiResponseSchema.safeParse(raw);
  if (!envelope.success) {
    return { accepted: [], rejected: ['Response JSON did not match the expected {"findings": [...]} shape.'] };
  }
  const shared = new Set(sharedFiles);
  const addedByFile = new Map(changes.files.map((f) => [f.path, new Set(addedLines(f).map((l) => l.line))]));
  const accepted: ReviewFinding[] = [];
  const rejected: string[] = [];

  for (const item of envelope.data.findings.slice(0, MAX_FINDINGS)) {
    const parsed = AiFindingSchema.safeParse(item);
    if (!parsed.success) {
      rejected.push('Malformed finding (missing or invalid fields).');
      continue;
    }
    const f = parsed.data;
    const file = normalizePath(f.file);
    if (!shared.has(file)) {
      rejected.push(`"${f.title}": file "${file}" was not part of the shared diff.`);
      continue;
    }
    const added = addedByFile.get(file) ?? new Set<number>();
    const near = [...Array(LINE_TOLERANCE * 2 + 1).keys()].map((d) => f.line - LINE_TOLERANCE + d).find((l) => added.has(l));
    if (near === undefined) {
      rejected.push(`"${f.title}": line ${f.line} of ${file} is not a line changed by this review.`);
      continue;
    }
    accepted.push({
      id: stableId('ai', file, near, f.title),
      ruleId: 'ai/review',
      severity: f.severity,
      verification: 'suspected',
      verificationNote: tr('Reported by {0}. AI output is not verification; no executed check backs this finding yet.', providerLabel),
      origin: 'ai',
      title: f.title,
      description: f.description,
      location: { file, startLine: near },
      evidence: [],
      ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}),
    });
  }
  if (envelope.data.findings.length > MAX_FINDINGS) {
    rejected.push(`${envelope.data.findings.length - MAX_FINDINGS} finding(s) over the limit of ${MAX_FINDINGS} were ignored.`);
  }
  const summary = parseSummary(envelope.data.summary, shared, providerLabel, rejected);
  return { accepted, rejected, ...(summary ? { summary } : {}) };
}
