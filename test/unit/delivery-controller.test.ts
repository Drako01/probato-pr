import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../../src/core/model';
import { DeliveryController, type DeliveryControllerDeps } from '../../src/extension/delivery-controller';
import { GitHubClient, type FetchFn } from '../../src/github/github-client';

const ui = vi.hoisted(() => ({
  trusted: true,
  warning: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  info: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  error: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  pick: vi.fn<(items: readonly unknown[], options?: unknown) => Promise<unknown>>(),
  input: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  show: vi.fn<(...args: unknown[]) => Promise<void>>(),
  document: vi.fn<(options: { readonly content: string; readonly language: string }) => Promise<{ getText: () => string }>>(),
}));
vi.mock('vscode', () => ({
  l10n: { t: (template: string, ...args: readonly (string | number)[]) => template.replace(/\{(\d+)\}/g, (_, index: string) => `${args[Number(index)] ?? ''}`) },
  workspace: {
    get isTrusted() { return ui.trusted; },
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/repo' } }],
    openTextDocument: ui.document,
  },
  window: {
    showWarningMessage: ui.warning, showInformationMessage: ui.info, showErrorMessage: ui.error,
    showQuickPick: ui.pick, showInputBox: ui.input, showTextDocument: ui.show,
    withProgress: (_options: unknown, action: (progress: unknown, token: { onCancellationRequested: (fn: () => void) => { dispose: () => void } }) => Promise<void>) => action({}, { onCancellationRequested: () => ({ dispose: () => undefined }) }),
  },
  ProgressLocation: { Notification: 15, Window: 10 },
}));

const sha = 'a'.repeat(40);
/** Git prints forward slashes even on Windows; reviews store the path.normalize()d form, so they differ there. */
const gitTopLevel = 'C:/repo';
const pull = { number: 7, node_id: 'PR7', title: 'Reviewed change', body: 'Existing description', html_url: 'https://github.com/owner/repo/pull/7', state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean', user: { id: 1, login: 'author' }, head: { sha, ref: 'feature' }, base: { sha: 'b'.repeat(40), ref: 'main' } };
const repo = { default_branch: 'main', allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, permissions: { push: true } };
function review(kind: ReviewResult['scope']['kind'] = 'branch'): ReviewResult {
  return {
    id: 'r', createdAt: '2026-11-02T12:00:00Z', toolVersion: 'test',
    scope: { kind, label: 'Review', headSha: sha, headIsWorkingTree: kind === 'working' },
    repository: { name: 'repo', root: path.normalize(gitTopLevel), branch: 'feature', headSha: sha },
    stats: { filesChanged: 1, additions: 1, deletions: 0, filesSkipped: 0 },
    changedFiles: ['a.ts'], skipped: [], findings: [], evidence: [], checks: [], analyzerRuns: [], aiRuns: [],
    risk: { level: 'low', reasons: [], limitations: [], counts: { byVerification: { confirmed: 0, evidenced: 0, suspected: 0, 'not-verified': 0 }, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, checks: { passed: 0, failed: 0, notRun: 0 }, regressions: 0 } },
  };
}
const controllerSession = (controller: DeliveryController): unknown => (controller as unknown as { deps: { session: unknown } }).deps.session;
/** A review of a GitHub pull request through the API: no local checkout, so no repository root. */
function remoteReview(): ReviewResult {
  const base = review('pull-request');
  return { ...base, scope: { ...base.scope, headIsWorkingTree: false, pullRequest: { owner: 'owner', repo: 'repo', number: 7, url: pull.html_url } }, repository: { ...base.repository, root: '' } };
}
interface Request { readonly url: string; readonly init: RequestInit }
function body(request: Request | undefined): unknown { return JSON.parse(typeof request?.init.body === 'string' ? request.init.body : '{}') as unknown; }
function fixture(options: { readonly kind?: ReviewResult['scope']['kind']; readonly remote?: boolean; readonly existing?: boolean; readonly remoteSha?: string; readonly busy?: boolean } = {}) {
  const requests: Request[] = [];
  const fetch: FetchFn = (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/repos/owner/repo')) return Promise.resolve(Response.json(repo));
    if (url.includes('/pulls?')) return Promise.resolve(Response.json(options.existing ? [pull] : []));
    if (url.endsWith('/pulls/7')) return Promise.resolve(Response.json(pull));
    if (url.includes('/git/ref/heads/')) return Promise.resolve(Response.json({ object: { sha: options.remoteSha ?? sha } }));
    if (url.endsWith('/pulls') && init.method === 'POST') return Promise.resolve(Response.json(pull));
    if (url.endsWith('/user')) return Promise.resolve(Response.json({ id: 1, login: 'author' }));
    if (url.includes('/issues/7/comments')) return Promise.resolve(Response.json(init.method === 'POST' ? { id: 99, body: '', html_url: 'https://github.com/owner/repo/pull/7#issuecomment-99', user: { id: 1, login: 'author' } } : []));
    return Promise.resolve(new Response('', { status: 500 }));
  };
  const snapshot = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const signIn = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const state = new Map<string, unknown>();
  const exclusive = vi.fn(async (_label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (options.busy) throw new Error('Already running');
    await action(new AbortController().signal);
  });
  const git = {
    topLevel: vi.fn<() => Promise<string>>().mockResolvedValue(gitTopLevel),
    remoteUrl: vi.fn<() => Promise<string>>().mockResolvedValue('https://github.com/owner/repo.git'),
    currentBranch: vi.fn<() => Promise<string>>().mockResolvedValue('feature'),
    resolveCommit: vi.fn<() => Promise<string>>().mockResolvedValue(sha),
    isDirty: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  };
  const deps = {
    session: { current: options.remote ? remoteReview() : review(options.kind), exclusive, visibleFindings: () => [], cancel: vi.fn() },
    git, github: new GitHubClient(fetch, () => Promise.resolve('synthetic-token')),
    state: { get: (key: string) => state.get(key), update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); } },
    signInToGitHub: signIn, ensureReviewCurrent: snapshot, log: { warn: vi.fn(), info: vi.fn(), show: vi.fn() },
  } as unknown as DeliveryControllerDeps;
  return { controller: new DeliveryController(deps), requests, snapshot, signIn, state, git, exclusive };
}
const writes = (requests: readonly Request[]) => requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.init.method ?? 'GET'));

beforeEach(() => {
  vi.resetAllMocks();
  ui.trusted = true;
  ui.warning.mockResolvedValue('Confirm');
  ui.info.mockResolvedValue('Continue');
  ui.pick.mockImplementation((items) => Promise.resolve(items[0]));
  ui.input.mockResolvedValueOnce('main').mockResolvedValueOnce('Reviewed change');
  ui.show.mockResolvedValue(undefined);
  ui.document.mockImplementation((options) => Promise.resolve({ getText: () => options.content }));
});

describe('DeliveryController host boundaries', () => {
  it('blocks every public action, including authentication and menu access, in an untrusted workspace', async () => {
    ui.trusted = false;
    const { controller, requests, signIn, git } = fixture();
    await controller.open(); await controller.signIn(); await controller.publishPullRequest();
    await controller.publishReview(); await controller.status(); await controller.watch();
    await controller.merge(); await controller.selectPullRequest();
    expect(requests).toEqual([]);
    expect(signIn).not.toHaveBeenCalled();
    expect(git.topLevel).not.toHaveBeenCalled();
    expect(ui.pick).not.toHaveBeenCalled();
    expect(ui.warning).toHaveBeenCalledTimes(8);
  });
  it('does not mutate GitHub when the exact publication preview is cancelled', async () => {
    ui.warning.mockResolvedValue(undefined);
    const { controller, requests, snapshot } = fixture();
    await controller.publishPullRequest();
    expect(writes(requests)).toEqual([]);
    expect(snapshot).toHaveBeenCalledOnce();
    const confirmation = ui.warning.mock.calls[0];
    expect(confirmation?.[0]).toBe('Publish this pull request?');
    expect((confirmation?.[1] as { readonly detail: string }).detail).toContain(`owner/repo\nfeature -> main\n${sha}`);
    expect(confirmation?.[2]).toBe('Confirm');
  });
  it('shows the exact description and reviewed SHA before creating a PR and persists its identity', async () => {
    const { controller, requests, snapshot, state } = fixture();
    await controller.publishPullRequest();
    const write = writes(requests)[0];
    expect(writes(requests)).toHaveLength(1);
    expect(body(write)).toMatchObject({ title: 'Reviewed change', head: 'feature', base: 'main', draft: true });
    const payload = body(write) as { readonly body: string };
    expect(payload.body).toContain(`<!-- probato-pr:reviewed-sha:${sha} -->`);
    const approved = ui.warning.mock.calls.find((c) => c[0] === 'Publish this pull request?')?.[1] as { readonly detail: string };
    expect(approved.detail).toContain(payload.body);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(state.get(`probatoPR.delivery:${path.normalize(gitTopLevel)}`)).toMatchObject({ owner: 'owner', repo: 'repo', number: 7, headSha: sha });
  });
  it('does not publish after repository contents change during confirmation', async () => {
    const { controller, requests, snapshot } = fixture();
    snapshot.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Snapshot changed'));
    await controller.publishPullRequest();
    expect(writes(requests)).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith('Snapshot changed');
  });
  it('does not publish evidence for an unpushed remote SHA', async () => {
    const { controller, requests } = fixture({ remoteSha: 'old-head' });
    await controller.publishPullRequest();
    expect(writes(requests)).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('Push the reviewed commit'));
  });
  it('previews the exact existing PR before updating it', async () => {
    ui.input.mockReset(); ui.input.mockResolvedValue('Updated title');
    const { controller, requests, snapshot } = fixture({ existing: true });
    await controller.publishPullRequest();
    expect(writes(requests)).toHaveLength(1);
    expect(writes(requests)[0]?.url.endsWith('/pulls/7')).toBe(true);
    expect(writes(requests)[0]?.init.method).toBe('PATCH');
    expect(body(writes(requests)[0])).toMatchObject({ title: 'Updated title' });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
  it.each(['working', 'staged'] as const)('rejects publication of findings from an uncommitted %s review', async (kind) => {
    const { controller, requests } = fixture({ kind, existing: true });
    await controller.publishReview();
    expect(writes(requests)).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith('Review the committed pull request head before publishing findings.');
  });
  it('respects the operation lock without making a GitHub request', async () => {
    const { controller, requests, exclusive } = fixture({ busy: true });
    await controller.publishPullRequest();
    expect(exclusive).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
    expect(ui.error).toHaveBeenCalledWith('Already running');
  });
});

describe('publishing the full analysis', () => {
  it('publishes a review of a GitHub pull request that has no local checkout', async () => {
    const { controller, requests, snapshot, git } = fixture({ remote: true });
    await controller.publishAnalysis();
    expect(ui.error).not.toHaveBeenCalled();
    expect(git.topLevel).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    const created = writes(requests).find((r) => r.url.endsWith('/issues/7/comments'));
    expect((body(created) as { body: string }).body).toContain(`probato-pr:analysis-sha:${sha}`);
  });

  it('ends the operation without waiting for the result notification to be dismissed', async () => {
    ui.info.mockReset().mockResolvedValueOnce('Continue').mockReturnValueOnce(new Promise(() => undefined));
    const { controller, requests } = fixture({ remote: true });
    await controller.publishAnalysis();
    expect(writes(requests).some((r) => r.url.endsWith('/issues/7/comments'))).toBe(true);
  });

  it('refuses a remote review whose commit is no longer the pull request head', async () => {
    const { controller, requests } = fixture({ remote: true });
    const stale = { ...remoteReview(), scope: { ...remoteReview().scope, headSha: 'c'.repeat(40) } };
    (controllerSession(controller) as { current: ReviewResult }).current = stale;
    await controller.publishAnalysis();
    expect(ui.error).toHaveBeenCalledWith('Review the committed pull request head before publishing the analysis.');
    expect(writes(requests)).toEqual([]);
  });
});
