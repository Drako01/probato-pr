import { describe, expect, it } from 'vitest';
import { activeFilter, filterFindings } from '../../src/ui/finding-filter';
import type { SummaryFinding } from '../../src/ui/summary-protocol';
import { SUMMARY_COMMAND_IDS, SUMMARY_COMMANDS, webviewMessageSchema } from '../../src/ui/summary-protocol';
import { workflowOf } from '../../src/ui/workflow';

describe('workflowOf', () => {
  const reviewed = { hasReview: true, hasLocalCheckout: true, checksRun: 0, checksAvailable: 2 };

  it('starts at review when there is no review', () => {
    expect(workflowOf({ hasReview: false, hasLocalCheckout: false, checksRun: 0, checksAvailable: undefined })).toEqual({ review: 'current', verify: 'todo', share: 'todo', next: 'review' });
  });

  it('points to verify after a local review with checks available', () => {
    expect(workflowOf(reviewed)).toEqual({ review: 'done', verify: 'current', share: 'todo', next: 'verify' });
  });

  it('still offers verify while check detection has not run (restored review)', () => {
    expect(workflowOf({ ...reviewed, checksAvailable: undefined }).next).toBe('verify');
  });

  it('points to share once checks ran', () => {
    expect(workflowOf({ ...reviewed, checksRun: 3 })).toEqual({ review: 'done', verify: 'done', share: 'current', next: 'share' });
  });

  it('skips verify with a reason when no checks are detected', () => {
    expect(workflowOf({ ...reviewed, checksAvailable: 0 })).toMatchObject({ verify: 'unavailable', verifyBlocker: 'no-checks', next: 'share' });
  });

  it('skips verify for API-only pull request reviews', () => {
    expect(workflowOf({ ...reviewed, hasLocalCheckout: false })).toMatchObject({ verify: 'unavailable', verifyBlocker: 'remote-only', next: 'share' });
  });
});

describe('webviewMessageSchema', () => {
  it('accepts every allowlisted command and maps it to a Probato PR command', () => {
    for (const command of SUMMARY_COMMANDS) {
      expect(webviewMessageSchema.safeParse({ type: 'command', command }).success).toBe(true);
      expect(SUMMARY_COMMAND_IDS[command]).toMatch(/^probatoPR\./);
    }
  });

  it('rejects commands outside the allowlist', () => {
    expect(webviewMessageSchema.safeParse({ type: 'command', command: 'workbench.action.terminal.new' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ type: 'command', command: 'probatoPR.verify' }).success).toBe(false);
  });

  it('rejects unknown types, missing ids and oversized ids', () => {
    expect(webviewMessageSchema.safeParse({ type: 'runShell', command: 'rm -rf /' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ type: 'openFinding' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ type: 'openFinding', id: '' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ type: 'openEvidence', id: 'x'.repeat(201) }).success).toBe(false);
    expect(webviewMessageSchema.safeParse(null).success).toBe(false);
  });

  it('accepts well-formed finding and evidence messages', () => {
    expect(webviewMessageSchema.parse({ type: 'dismissFinding', id: 'f-1' })).toEqual({ type: 'dismissFinding', id: 'f-1' });
    expect(webviewMessageSchema.parse({ type: 'ready' })).toEqual({ type: 'ready' });
  });
});

describe('filterFindings', () => {
  const finding = (over: Partial<SummaryFinding>): SummaryFinding => ({ id: 'f', severity: 'high', severityLabel: 'High', verification: 'suspected', verificationLabel: 'Suspected', title: 'SQL built from input', description: '', note: '', file: 'src/db/query.ts', line: 1, ruleId: 'sql-injection', explanation: { observation: '', observationNote: '', evidence: [], checks: [], missingProof: [] }, ...over });
  const all = [finding({ id: 'a' }), finding({ id: 'b', severity: 'low', verification: 'confirmed', title: 'Unused import', file: 'src/ui/view.ts', ruleId: 'unused-import' })];
  const ids = (filter: { severity?: string; verification?: string; query?: string }) => filterFindings(all, { severity: 'all', verification: 'all', query: '', ...filter }).map((f) => f.id);

  it('returns everything when no filter is active', () => { expect(ids({})).toEqual(['a', 'b']); });
  it('matches severity and verification exactly and combines them', () => {
    expect(ids({ severity: 'low' })).toEqual(['b']);
    expect(ids({ verification: 'suspected' })).toEqual(['a']);
    expect(ids({ severity: 'low', verification: 'suspected' })).toEqual([]);
  });
  it('searches title, file and rule case-insensitively, ignoring surrounding spaces', () => {
    expect(ids({ query: '  SQL ' })).toEqual(['a']);
    expect(ids({ query: 'ui/VIEW' })).toEqual(['b']);
    expect(ids({ query: 'unused-import' })).toEqual(['b']);
  });
  it('drops a stale saved selection that no longer matches anything', () => {
    expect(activeFilter('critical', ['high', 'low'])).toBe('all');
    expect(activeFilter('high', ['high', 'low'])).toBe('high');
  });
});
