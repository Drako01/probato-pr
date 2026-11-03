import { describe, expect, it } from 'vitest';
import { classify, isActive, parseArgs, publishInvocation, publishWithRetry, waitUntilActive } from '../../scripts/open-vsx-publish.mjs';

const INACTIVE_OUTPUT = "Extension armotusitio.probato-pr 0.1.2 is already published, but currently isn't active and therefore not visible.";

function scripted(results: { code: number; output: string }[]) {
  const sleeps: number[] = [];
  let calls = 0;
  return {
    sleeps,
    calls: () => calls,
    options: {
      run: () => Promise.resolve(results[Math.min(calls++, results.length - 1)] as { code: number; output: string }),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      log: () => undefined,
    },
  };
}

describe('classify', () => {
  it('tells a published version, an inactive one, a bad token and a retryable failure apart', () => {
    expect(classify('', 0)).toBe('published');
    expect(classify(INACTIVE_OUTPUT, 1)).toBe('inactive');
    expect(classify('Invalid access token.', 1)).toBe('fatal');
    expect(classify('connect ETIMEDOUT', 1)).toBe('retry');
  });
});

describe('parseArgs', () => {
  it('parses the publish and check modes and rejects incomplete input', () => {
    expect(parseArgs(['probato-pr.vsix'])).toEqual({ mode: 'publish', vsix: 'probato-pr.vsix' });
    expect(parseArgs(['probato-pr.vsix', '--version', '0.1.2'])).toEqual({ mode: 'publish', vsix: 'probato-pr.vsix', version: '0.1.2' });
    expect(parseArgs(['--check', '0.1.2'])).toEqual({ mode: 'check', version: '0.1.2' });
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['--check'])).toThrow(/needs a version/);
    expect(() => parseArgs(['a.vsix', '--version'])).toThrow(/needs a value/);
  });
});

describe('isActive', () => {
  it('is false for an error body, a different version or a failed request, and true for the exact version', async () => {
    const options = { url: 'u', version: '1.0.0' };
    const answer = (body: { error?: string; version?: string }) => () => Promise.resolve({ json: () => Promise.resolve(body) });
    await expect(isActive({ ...options, fetchImpl: answer({ error: 'Extension not found' }) })).resolves.toBe(false);
    await expect(isActive({ ...options, fetchImpl: answer({ version: '0.9.0' }) })).resolves.toBe(false);
    await expect(isActive({ ...options, fetchImpl: () => Promise.reject(new Error('offline')) })).resolves.toBe(false);
    await expect(isActive({ ...options, fetchImpl: answer({ version: '1.0.0' }) })).resolves.toBe(true);
  });
});

describe('publishWithRetry', () => {
  it('retries transient failures with a growing delay and then succeeds', async () => {
    const run = scripted([{ code: 1, output: 'HTTP 503' }, { code: 1, output: 'HTTP 503' }, { code: 0, output: 'Published' }]);
    await expect(publishWithRetry({ ...run.options, baseDelayMs: 10 })).resolves.toBe('published');
    expect(run.calls()).toBe(3);
    expect(run.sleeps).toEqual([10, 30]);
  });

  it('gives up after the last attempt and reports the output', async () => {
    const run = scripted([{ code: 1, output: 'HTTP 503' }]);
    await expect(publishWithRetry({ ...run.options, attempts: 2, baseDelayMs: 1 })).rejects.toThrow(/after 2 attempt.*HTTP 503/s);
    expect(run.calls()).toBe(2);
  });

  it('fails immediately on an invalid token without retrying', async () => {
    const run = scripted([{ code: 1, output: 'Invalid access token.' }]);
    await expect(publishWithRetry(run.options)).rejects.toThrow(/Invalid access token/);
    expect(run.calls()).toBe(1);
  });

  it('reports a version held back by the registry instead of failing', async () => {
    const run = scripted([{ code: 1, output: INACTIVE_OUTPUT }]);
    await expect(publishWithRetry(run.options)).resolves.toBe('inactive');
    expect(run.calls()).toBe(1);
  });
});

describe('waitUntilActive', () => {
  const base = { url: 'https://open-vsx.org/api/a/b/1.0.0', version: '1.0.0' };

  function clock() {
    let time = 0;
    return {
      now: () => time,
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
    };
  }

  it('returns true once the version shows up, ignoring transient errors before it', async () => {
    const answers = [() => Promise.reject(new Error('network')), () => ({ error: 'Extension not found' }), () => ({ version: '1.0.0' })];
    let call = 0;
    const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve((answers[call++] as () => { error?: string; version?: string })()) });
    await expect(waitUntilActive({ ...base, ...clock(), fetchImpl, intervalMs: 1_000 })).resolves.toBe(true);
    expect(call).toBe(3);
  });

  it('returns false when the version never becomes active before the deadline', async () => {
    const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve({ error: 'Extension not found' }) });
    await expect(waitUntilActive({ ...base, ...clock(), fetchImpl, timeoutMs: 5_000, intervalMs: 1_000 })).resolves.toBe(false);
  });
});


describe('Open VSX trusted publisher boundary', () => {
  it('requires OIDC in trusted mode and removes PAT precedence without touching the parent environment', () => {
    const environment = { OVSX_PAT: 'test-only', OVSX_TOKEN: 'test-only', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.invalid' };
    const invocation = publishInvocation('extension.vsix', true, environment);
    expect(invocation.args).toContain('--trusted-publishing');
    expect(invocation.env.OVSX_PAT).toBeUndefined();
    expect(invocation.env.OVSX_TOKEN).toBeUndefined();
    expect(invocation.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    expect(environment.OVSX_PAT).toBe('test-only');
  });
  it('parses trusted publishing with an explicit release version and fails invalid options', () => {
    expect(parseArgs(['a.vsix', '--version', '0.5.0', '--trusted-publishing'])).toEqual({ mode: 'publish', vsix: 'a.vsix', version: '0.5.0', trustedPublishing: true });
    expect(() => parseArgs(['a.vsix', '--trusted-publishing', '--trusted-publishing'])).toThrow(/duplicate/);
    expect(classify('No matching trusted publisher', 1)).toBe('fatal');
  });
});
