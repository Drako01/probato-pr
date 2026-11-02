import { z } from 'zod';
import { stableId } from '../core/ids';
import type { ChangeSet, ReviewFinding } from '../core/model';
import { addedLines } from '../git/diff-parser';

const MAX_FINDINGS = 50;
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
const AiResponseSchema = z.object({ findings: z.array(z.unknown()).max(500) });

export interface ParsedAiFindings {
  readonly accepted: readonly ReviewFinding[];
  readonly rejected: readonly string[];
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
export function parseAiFindings(text: string, changes: ChangeSet, sharedFiles: readonly string[], providerLabel: string): ParsedAiFindings {
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
    const file = f.file.replace(/^\.?\//, '');
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
      verificationNote: `Reported by ${providerLabel}. AI output is not verification; no executed check backs this finding yet.`,
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
  return { accepted, rejected };
}
