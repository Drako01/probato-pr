// Single catalog of secret patterns. Used to detect secrets added in a diff, to redact
// command output stored as evidence, and to scrub context before it reaches an AI provider.

import { msg, type Message } from './i18n';

export interface SecretPattern {
  readonly id: string;
  readonly label: Message;
  /** Specific token formats are high confidence; generic assignments are medium. */
  readonly confidence: 'high' | 'medium';
  readonly regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private-key',
    label: msg('Private key block'),
    confidence: 'high',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { id: 'aws-access-key', label: msg('AWS access key ID'), confidence: 'high', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: msg('GitHub token'), confidence: 'high', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: 'anthropic-key', label: msg('Anthropic API key'), confidence: 'high', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', label: msg('OpenAI API key'), confidence: 'high', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'slack-token', label: msg('Slack token'), confidence: 'high', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-live-key', label: msg('Stripe live secret key'), confidence: 'high', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { id: 'google-api-key', label: msg('Google API key'), confidence: 'high', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: 'jwt',
    label: msg('JSON Web Token'),
    confidence: 'medium',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: 'connection-string-password',
    label: msg('Credentials in connection string'),
    confidence: 'high',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"]{3,}@[^\s'"]+/gi,
  },
  {
    id: 'generic-secret-assignment',
    label: msg('Hard-coded secret value'),
    confidence: 'medium',
    regex:
      /\b[\w.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
  },
];

/** Values that look like an assignment but are obviously not real secrets. */
const PLACEHOLDER = /^(?:x+|\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|changeme|change-me|your[_-].*|example.*|placeholder|dummy|test.*|fake.*|redacted|process\.env.*)$/i;

export interface SecretMatch {
  readonly pattern: SecretPattern;
  readonly index: number;
  readonly length: number;
}

export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) {
      const value = m[1] ?? m[0];
      if (pattern.id === 'generic-secret-assignment' && PLACEHOLDER.test(value)) {
        continue;
      }
      matches.push({ pattern, index: m.index, length: m[0].length });
    }
  }
  return matches;
}

/** Replaces every detected secret with a marker naming its type, so redacted text stays readable. */
export function redactSecrets(text: string): string {
  const matches = findSecrets(text).sort((a, b) => b.index - a.index);
  let result = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const end = match.index + match.length;
    if (end > lastStart) {
      continue; // overlapping match already redacted
    }
    result = `${result.slice(0, match.index)}[REDACTED:${match.pattern.id}]${result.slice(end)}`;
    lastStart = match.index;
  }
  return result;
}

/** Files that must never leave the machine nor be echoed into reports, regardless of user settings. */
export const SENSITIVE_FILE_GLOBS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/credentials',
  '**/credentials.json',
  '**/*secret*.json',
  '**/*.tfstate',
  '**/*.tfvars',
];
