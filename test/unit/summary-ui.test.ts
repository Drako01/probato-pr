import { describe, expect, it } from 'vitest';
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
