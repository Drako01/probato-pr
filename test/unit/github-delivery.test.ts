import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, type FetchFn } from '../../src/github/github-client';
import { buildReviewDraft, commentMarker, GitHubDelivery, type DeliveryPull, type InlineDraft } from '../../src/github/delivery';
import type { ReviewFinding } from '../../src/core/model';

const ref = { owner: 'owner', repo: 'repo' };
const sha = 'a'.repeat(40);
const pull: DeliveryPull = { number: 7, node_id: 'PR_7', title: 'Change', body: 'Description', html_url: 'https://github.com/owner/repo/pull/7', state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean', user: { id: 1, login: 'author' }, head: { sha, ref: 'feature' }, base: { sha: 'b'.repeat(40), ref: 'main' } };
const repo = { default_branch: 'main', allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, permissions: { push: true } };
const file = { filename: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };
function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding { return { id: 'f', ruleId: 'rule/one', title: 'Defect', description: 'A concrete defect', severity: 'high', verification: 'suspected', verificationNote: 'Not verified', origin: 'ai', location: { file: 'src/a.ts', startLine: 1 }, evidence: [], ...overrides }; }
function fixture(handler?: (url: string, init: RequestInit) => Response | undefined) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFn = vi.fn((url: string, init: RequestInit) => {
    requests.push({ url, init });
    const custom = handler?.(url, init);
    if (custom) return Promise.resolve(custom);
    if (url.endsWith('/pulls/7')) return Promise.resolve(Response.json(pull));
    if (url.endsWith('/repos/owner/repo')) return Promise.resolve(Response.json(repo));
    if (url.includes('/check-runs?')) return Promise.resolve(Response.json({ check_runs: [] }));
    if (url.includes('/statuses?')) return Promise.resolve(Response.json([]));
    if (url.endsWith('/graphql')) return Promise.resolve(Response.json({ data: { repository: { pullRequest: { headRefOid: sha, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' } } } }));
    if (url.endsWith('/user')) return Promise.resolve(Response.json({ id: 2, login: 'reviewer' }));
    if (url.includes('/comments?')) return Promise.resolve(Response.json([]));
    if (url.includes('/git/ref/heads/')) return Promise.resolve(Response.json({ object: { sha } }));
    return Promise.resolve(new Response('', { status: 500 }));
  });
  const client = new GitHubClient(fetch, () => Promise.resolve('synthetic-token'));
  return { client, delivery: new GitHubDelivery(client), requests };
}
function stringBody(request: { readonly init: RequestInit } | undefined): string { return typeof request?.init.body === 'string' ? request.init.body : ''; }
const writes = (requests: readonly { url: string; init: RequestInit }[]) => requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.init.method ?? 'GET') && !(r.url.endsWith('/graphql') && stringBody(r).includes('query(')));

 describe('GitHub review draft', () => {
  it('keeps semantic identity across a line shift and validates the current patch', () => {
    const first = buildReviewDraft([finding()], [file]);
    const second = buildReviewDraft([finding({ location: { file: 'src/a.ts', startLine: 5 } })], [{ ...file, patch: '@@ -5 +5 @@\n-old\n+new' }]);
    expect(first.comments[0]?.key).toBe(second.comments[0]?.key);
    expect(first.comments[0]).toMatchObject({ line: 1, side: 'RIGHT' });
  });
  it('uses LEFT for deleted files and refuses arbitrary locations', () => {
    const removed = { ...file, status: 'removed' as const, patch: '@@ -1 +0,0 @@\n-old' };
    expect(buildReviewDraft([finding()], [removed]).comments[0]?.side).toBe('LEFT');
    const out = buildReviewDraft([finding({ location: { file: 'src/a.ts', startLine: 900 } })], [file]);
    expect(out.comments).toEqual([]);
    expect(out.skipped).toHaveLength(1);
  });
  it('preserves repeated findings, limits comments and redacts their content', () => {
    const token = 'sk-proj-' + 'A'.repeat(40);
    const result = buildReviewDraft([finding({ description: token }), finding({ title: 'Another' })], [file], 1);
    expect(result.comments).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.comments[0]?.body).toContain('Another');
    expect(result.comments[0]?.body).not.toContain(token);
    const duplicated = buildReviewDraft([finding(), finding()], [file]);
    expect(duplicated.comments).toHaveLength(1);
    expect(duplicated.comments[0]?.body.match(/A concrete defect/g)).toHaveLength(2);
  });
 });

 describe('GitHub delivery transport and PR creation', () => {
  it('paginates open pull requests and refuses redirecting an authenticated request', async () => {
    const p = { number: 7, title: 'Change', html_url: pull.html_url, state: 'open', user: { login: 'author' }, head: pull.head, base: pull.base };
    const { client, requests } = fixture((url) => url.includes('/pulls?') ? Response.json(new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, () => p) : [p]) : undefined);
    expect(await client.listOpenPulls(ref)).toHaveLength(101);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init.redirect).toBe('error');
  });
  it('refuses to publish an unpushed SHA without writing', async () => {
    const { delivery, requests } = fixture();
    await expect(delivery.createOrUpdate(ref, { title: 'T', body: 'B', head: 'feature', base: 'main', draft: true, expectedSha: 'different' })).rejects.toThrow(/Push/);
    expect(writes(requests)).toEqual([]);
  });
  it('creates the selected draft with no internal approval metadata in the payload', async () => {
    const { delivery, requests } = fixture((url, init) => {
      if (url.includes('/pulls?')) return Response.json([]);
      if (url.endsWith('/pulls') && init.method === 'POST') return Response.json({ ...pull, draft: true });
      return undefined;
    });
    await delivery.createOrUpdate(ref, { title: 'T', body: 'B', head: 'feature', base: 'main', draft: true, expectedSha: sha });
    const write = writes(requests)[0];
    expect(JSON.parse(stringBody(write))).toEqual({ title: 'T', body: 'B', head: 'feature', base: 'main', draft: true });
    expect(requests.some((r) => r.url.includes('head=owner%3Afeature'))).toBe(true);
  });
  it('updates only the explicitly previewed existing PR and rejects a newly appeared one', async () => {
    const { delivery, requests } = fixture((url) => url.includes('/pulls?') ? Response.json([pull]) : undefined);
    await expect(delivery.createOrUpdate(ref, { title: 'T', body: 'B', head: 'feature', base: 'main', draft: true, expectedSha: sha })).rejects.toThrow(/target pull request changed/);
    expect(writes(requests)).toEqual([]);
    await delivery.createOrUpdate(ref, { title: 'T', body: 'B', head: 'feature', base: 'main', draft: true, expectedSha: sha, expectedNumber: 7 });
    expect(writes(requests)[0]?.init.method).toBe('PATCH');
  });
  it('handles GraphQL errors instead of reporting a successful draft transition', async () => {
    const { delivery } = fixture((url) => url.endsWith('/graphql') ? Response.json({ errors: [{ message: 'denied' }] }) : undefined);
    await expect(delivery.setDraft(pull, true)).rejects.toThrow(/could not complete/);
  });
 });

 describe('merge readiness and expected SHA', () => {
  it('shows incomplete checks and blocks merging them', async () => {
    const { delivery, requests } = fixture((url) => url.includes('/check-runs?') ? Response.json({ check_runs: [{ id: 1, name: 'tests', status: 'in_progress', conclusion: null, details_url: null }] }) : undefined);
    expect((await delivery.status(ref, 7)).blockers).toContain('1 check(s) have not passed.');
    await expect(delivery.merge(ref, 7, sha, 'squash', pull.base)).rejects.toThrow(/have not passed/);
    expect(writes(requests)).toEqual([]);
  });
  it('blocks draft, conflict, pending mergeability and missing write permissions', async () => {
    for (const patch of [{ draft: true }, { mergeable: false }, { mergeable: null }, { mergeable_state: 'blocked' }]) {
      const { delivery, requests } = fixture((url) => url.endsWith('/pulls/7') ? Response.json({ ...pull, ...patch }) : undefined);
      await expect(delivery.merge(ref, 7, sha, 'squash', pull.base)).rejects.toThrow();
      expect(writes(requests)).toEqual([]);
    }
    const { delivery } = fixture((url) => url.endsWith('/repos/owner/repo') ? Response.json({ ...repo, permissions: { push: false } }) : undefined);
    await expect(delivery.merge(ref, 7, sha, 'squash', pull.base)).rejects.toThrow(/permissions/);
  });
  it('sends expected SHA and only enabled methods, refuses stale heads', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/merge') ? Response.json({ merged: true, sha: 'merged-sha', message: 'ok' }) : undefined);
    await expect(delivery.merge(ref, 7, 'old-head', 'squash', pull.base)).rejects.toThrow(/head commit changed/);
    await expect(delivery.merge(ref, 7, sha, 'rebase', pull.base)).rejects.toThrow(/disabled/);
    expect(await delivery.merge(ref, 7, sha, 'squash', pull.base)).toBe('merged-sha');
    expect(JSON.parse(stringBody(writes(requests)[0]))).toEqual({ sha, merge_method: 'squash' });
  });
  it('never retries or bypasses a server protection rejection', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/merge') ? new Response('', { status: 405 }) : undefined);
    await expect(delivery.merge(ref, 7, sha, 'squash', pull.base)).rejects.toThrow(/405/);
    expect(writes(requests)).toHaveLength(1);
  });
  it('binds merge queue admission to expectedHeadOid', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/graphql') ? Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'entry' } } } }) : undefined);
    await delivery.enqueue(ref, 7, sha, pull.base);
    const body = JSON.parse(stringBody(writes(requests)[0])) as { query: string; variables: unknown };
    expect(body.query).toContain('expectedHeadOid:$sha');
    expect(body.variables).toEqual({ id: 'PR_7', sha });
  });
 });

 describe('review reconciliation and conversations', () => {
  const comment: InlineDraft = { key: 'abc', path: 'src/a.ts', line: 1, side: 'RIGHT', body: `${commentMarker('abc')}\nNew text` };
  function oldComment(user = { id: 2, login: 'reviewer' }, app: { id: number } | null = null) { return { id: 123, body: `${commentMarker('abc')}\nOld text`, user, path: 'src/a.ts', line: 1, side: 'RIGHT', commit_id: sha, performed_via_github_app: app }; }
  it('preserves human and other-app comments containing copied markers', async () => {
    const { delivery, requests } = fixture((url) => {
      if (url.includes('/comments?')) return Response.json([oldComment({ id: 99, login: 'someone' }), oldComment(undefined, { id: 456 })]);
      if (url.endsWith('/reviews')) return Response.json({ id: 1 });
      return undefined;
    });
    expect(await delivery.publishReview(ref, 7, sha, { comments: [comment], skipped: [] })).toEqual({ created: 1, updated: 0 });
    expect(writes(requests).map((r) => r.init.method)).toEqual(['POST']);
    expect(JSON.parse(stringBody(writes(requests)[0]))).toMatchObject({ commit_id: sha, event: 'COMMENT' });
    expect(requests.some((r) => r.init.method === 'DELETE')).toBe(false);
  });
  it('updates only an owned comment on the same revision and never deletes disappeared findings', async () => {
    const { delivery, requests } = fixture((url) => {
      if (url.includes('/comments?')) return Response.json([oldComment()]);
      if (url.endsWith('/pulls/comments/123')) return Response.json({ ...oldComment(), body: comment.body });
      return undefined;
    });
    expect(await delivery.publishReview(ref, 7, sha, { comments: [comment], skipped: [] })).toEqual({ created: 0, updated: 1 });
    expect(await delivery.publishReview(ref, 7, sha, { comments: [], skipped: [] })).toEqual({ created: 0, updated: 0 });
    expect(writes(requests).map((r) => r.init.method)).toEqual(['PATCH']);
  });
  it('fault injection: a partial API failure is reported, and the retry neither re-edits nor duplicates', async () => {
    const second: InlineDraft = { ...comment, key: 'def', line: 2, body: `${commentMarker('def')}\nAnother` };
    let stored = oldComment();
    let reviewAttempts = 0;
    const { delivery, requests } = fixture((url, init) => {
      if (url.includes('/comments?')) return Response.json([stored]);
      if (url.endsWith('/pulls/comments/123')) { stored = { ...stored, body: comment.body }; return Response.json(stored); }
      // The first review POST fails after the PATCH was already applied: GitHub is left half updated.
      if (url.endsWith('/reviews') && init.method === 'POST') return ++reviewAttempts === 1 ? new Response('upstream error', { status: 502 }) : Response.json({ id: 1 });
      return undefined;
    });
    await expect(delivery.publishReview(ref, 7, sha, { comments: [comment, second], skipped: [] })).rejects.toThrow();
    expect(await delivery.publishReview(ref, 7, sha, { comments: [comment, second], skipped: [] })).toEqual({ created: 1, updated: 0 });
    expect(writes(requests).map((r) => `${r.init.method ?? 'GET'} ${r.url.replace(/^.*\/repos\/owner\/repo/, '')}`)).toEqual(['PATCH /pulls/comments/123', 'POST /pulls/7/reviews', 'POST /pulls/7/reviews']);
    expect((JSON.parse(stringBody(writes(requests)[2])) as { comments: unknown[] }).comments).toHaveLength(1);
  });
  it('refuses stale review publication and self approval before a write', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/user') ? Response.json({ id: 1, login: 'author' }) : undefined);
    await expect(delivery.publishReview(ref, 7, 'old', { comments: [comment], skipped: [] })).rejects.toThrow(/changed/);
    await expect(delivery.review(ref, 7, sha, 'APPROVE', 'looks good')).rejects.toThrow(/own pull request/);
    expect(writes(requests)).toEqual([]);
  });
  it('replies to the intended conversation and resolves or reopens it', async () => {
    const { delivery, requests } = fixture((url) => {
      if (url.endsWith('/replies')) return Response.json({ id: 5 });
      if (url.endsWith('/graphql')) return Response.json({ data: { resolveReviewThread: { thread: { id: 't', isResolved: true } } } });
      return undefined;
    });
    await delivery.reply(ref, 7, 123, 'Reply');
    await delivery.resolve('t', true);
    await delivery.resolve('t', false);
    expect(writes(requests)[0]?.url).toContain('/pulls/7/comments/123/replies');
    expect(stringBody(writes(requests)[1])).toContain('resolveReviewThread');
    expect(stringBody(writes(requests)[2])).toContain('unresolveReviewThread');
  });
 });

 describe('Actions log download', () => {
  it('never forwards the GitHub token to signed storage', async () => {
    const { client, requests } = fixture((url) => {
      if (url.endsWith('/actions/jobs/42/logs')) return new Response('', { status: 302, headers: { location: 'https://signed-storage.example/log' } });
      if (url === 'https://signed-storage.example/log') return new Response('CI log');
      return undefined;
    });
    expect(await client.jobLog(ref, 42)).toBe('CI log');
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
    expect(requests[1]?.init.headers).toBeUndefined();
    expect(requests[1]?.init.redirect).toBe('error');
  });
  it('rejects an insecure redirect and bounds large logs', async () => {
    const insecure = fixture((url) => url.includes('/logs') ? new Response('', { status: 302, headers: { location: 'http://insecure.example/log' } }) : undefined);
    await expect(insecure.client.jobLog(ref, 42)).rejects.toThrow(/invalid log download/);
    const bounded = fixture((url) => url.includes('/logs') ? new Response('x'.repeat(1_100_000)) : undefined);
    const text = await bounded.client.jobLog(ref, 42);
    expect(text).toHaveLength(1_000_000 + '\n[Log truncated at 1 MB]'.length);
  });
 });

 describe('delivery pagination and policy', () => {
  it('refuses an administrator bypass when review approval remains required', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/graphql') ? Response.json({ data: { repository: { pullRequest: { headRefOid: sha, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN' } } } }) : undefined);
    await expect(delivery.merge(ref, 7, sha, 'merge', pull.base)).rejects.toThrow(/review requirements/);
    expect(writes(requests)).toEqual([]);
  });
  it('reads every status page and keeps only the newest status per context', async () => {
    const old = { context: 'tests', state: 'failure', target_url: null };
    const { delivery } = fixture((url) => url.includes('/statuses?') ? Response.json(new URL(url).searchParams.get('page') === '1' ? [{ ...old, state: 'success' }, ...Array.from({ length: 99 }, () => old)] : [old]) : undefined);
    const result = await delivery.status(ref, 7);
    expect(result.checks).toEqual([{ name: 'tests', state: 'success', url: null }]);
    expect(result.blockers).toEqual([]);
  });
  it('does not silently truncate a PR at the GitHub file ceiling', async () => {
    const { client } = fixture((url) => url.includes('/files?') ? Response.json(Array.from({ length: 100 }, () => file)) : undefined);
    await expect(client.listPullFiles(ref, 7)).rejects.toThrow(/would be incomplete/);
  });
  it('paginates both threads and comments, including the root reply target', async () => {
    const comment = { databaseId: 10, body: 'Root', url: 'https://github.com/owner/repo/pull/7#discussion_10', author: { login: 'reviewer' } };
    const { delivery, requests } = fixture((url, init) => {
      if (!url.endsWith('/graphql')) return undefined;
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string; variables: { after?: string } };
      if (body.query.includes('node(id:$id)')) return Response.json({ data: { node: { comments: { nodes: [{ ...comment, databaseId: 11, body: 'Reply' }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: body.variables.after ? [] : [{ id: 'thread-1', isResolved: false, viewerCanResolve: true, comments: { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'comments-page-2' } } }], pageInfo: { hasNextPage: !body.variables.after, endCursor: 'threads-page-2' } } } } } });
    });
    const threads = await delivery.threads(ref, 7);
    expect(threads[0]?.comments.map((c) => c.body)).toEqual(['Root', 'Reply']);
    expect(requests).toHaveLength(3);
  });
 });

 describe('approved delivery destination', () => {
  it('refuses merging or queueing after the PR was retargeted with the same head', async () => {
    const { delivery, requests } = fixture((url) => url.endsWith('/pulls/7') ? Response.json({ ...pull, base: { ...pull.base, ref: 'production' } }) : undefined);
    await expect(delivery.merge(ref, 7, sha, 'squash', pull.base)).rejects.toThrow(/changed/);
    await expect(delivery.enqueue(ref, 7, sha, pull.base)).rejects.toThrow(/target branch changed/);
    expect(writes(requests)).toEqual([]);
  });
  it('does not report reviewed evidence as published when a branch moves during PR creation', async () => {
    const { delivery } = fixture((url, init) => url.includes('/pulls?') ? Response.json([]) : url.endsWith('/pulls') && init.method === 'POST' ? Response.json({ ...pull, head: { ...pull.head, sha: 'new-head' } }) : undefined);
    await expect(delivery.createOrUpdate(ref, { title: 'T', body: 'B', head: 'feature', base: 'main', draft: true, expectedSha: sha })).rejects.toThrow(/was created, but/);
  });
 });
