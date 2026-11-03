import { redactSecrets } from './secrets';

// These fields identify evidence and locations; rewriting them would break links and attribution.
const STRUCTURAL = new Set(['id', 'ruleId', 'analyzerId', 'checkId', 'evidenceId', 'headEvidenceId', 'baseEvidenceId',
  'file', 'path', 'oldPath', 'root', 'cwd', 'changedFiles', 'filesShared', 'commitSha', 'headSha', 'baseSha',
  'outputSha256', 'fingerprint', 'kind', 'origin', 'severity', 'verification', 'attribution', 'status']);

/** A final boundary for untrusted human-readable text in reviews, stored state and exported reports. */
export function sanitizeText<T>(value: T, field = ''): T {
  if (STRUCTURAL.has(field)) {
    return value;
  }
  if (typeof value === 'string') {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    const sanitized: unknown[] = value.map((item: unknown) => sanitizeText(item, field));
    return sanitized.every((item, index) => item === value[index]) ? value : sanitized as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const sanitized = entries.map(([key, item]) => [key, sanitizeText(item, key)] as const);
    return entries.every(([, item], index) => item === sanitized[index]?.[1]) ? value : Object.fromEntries(sanitized) as T;
  }
  return value;
}
