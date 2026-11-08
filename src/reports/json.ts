import { explainFinding } from '../core/finding-explanation';
import type { GateDecision } from '../core/quality-gate';
import type { ReviewComparison } from '../core/review-comparison';
import { sanitizeText } from '../core/sanitize';
import type { ReviewResult } from '../core/model';

export const REPORT_SCHEMA_VERSION = 1;

/**
 * Full machine-readable review, including every evidence record, for archiving or CI consumption.
 * `qualityGate` is an additive optional field (schema version unchanged): readers that ignore it keep working.
 */
export function renderJson(result: ReviewResult, comparison?: ReviewComparison, qualityGate?: GateDecision): string {
  result = sanitizeText(result);
  return `${JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, generator: 'probato-pr', ...result, findingExplanations: result.findings.map((finding) => ({ findingId: finding.id, ...explainFinding(result, finding) })), ...(comparison ? { comparison: sanitizeText(comparison) } : {}), ...(qualityGate ? { qualityGate: sanitizeText(qualityGate) } : {}) }, null, 2)}\n`;
}
