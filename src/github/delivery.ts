import { tr } from '../core/i18n';
import { severityLabel, verificationLabel } from '../core/labels';
import { z } from 'zod';
import { stableId } from '../core/ids';
import type { ReviewFinding } from '../core/model';
import { redactSecrets } from '../core/secrets';
import { escapeMarkdown } from '../reports/markdown';
import { GitHubClient, GitHubError, PullSchema, type GitHubRepoRef, type PullFile } from './github-client';
import { toFileChange } from './pull-request-changes';

const UserSchema = z.object({ id: z.number().int(), login: z.string() });
export const DeliveryPullSchema = z.object({
  number: z.number().int().positive(), node_id: z.string(), title: z.string(), body: z.string().nullable(),
  html_url: z.url(), state: z.string(), draft: z.boolean(), merged: z.boolean(),
  mergeable: z.boolean().nullable(), mergeable_state: z.string(), user: UserSchema.nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }), base: z.object({ sha: z.string(), ref: z.string() }),
});
export type DeliveryPull = z.infer<typeof DeliveryPullSchema>;
const RepoSchema = z.object({ default_branch: z.string(), allow_merge_commit: z.boolean(), allow_squash_merge: z.boolean(), allow_rebase_merge: z.boolean(), permissions: z.object({ push: z.boolean() }).optional() });
export type RepositoryCapabilities = z.infer<typeof RepoSchema>;
const CheckSchema = z.object({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), details_url: z.string().nullable(), html_url: z.string().optional() });
const StatusSchema = z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable() });
const ReviewCommentSchema = z.object({ id: z.number(), body: z.string(), user: UserSchema.nullable(), path: z.string(), line: z.number().nullable(), side: z.string().optional(), commit_id: z.string(), performed_via_github_app: z.object({ id: z.number() }).nullable().optional() });
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export interface DeliveryStatus {
  readonly pull: DeliveryPull;
  readonly checks: readonly { readonly name: string; readonly state: string; readonly url: string | null }[];
  readonly blockers: readonly string[];
  readonly methods: readonly MergeMethod[];
}
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export interface InlineDraft { readonly key: string; readonly path: string; readonly line: number; readonly side: 'LEFT' | 'RIGHT'; readonly body: string }
export interface ReviewDraft { readonly comments: readonly InlineDraft[]; readonly skipped: readonly string[] }
const MARKER = '<!-- probato-pr:inline:v1:';
const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };
export function commentMarker(key: string): string { return `${MARKER}${key} -->`; }

/** Location validation uses the PR patch, including removed lines on LEFT. Keys follow semantic context, not line numbers. */
export function buildReviewDraft(findings: readonly ReviewFinding[], files: readonly PullFile[], limit = 20): ReviewDraft {
  const changes = files.map(toFileChange);
  const comments: InlineDraft[] = [];
  const skipped: string[] = [];
  const occurrences = new Map<string, number>();
  for (const f of [...findings].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.location.file.localeCompare(b.location.file) || a.location.startLine - b.location.startLine)) {
    const file = changes.find((c) => c.path === f.location.file || c.oldPath === f.location.file);
    let side: 'LEFT' | 'RIGHT' = file?.status === 'deleted' ? 'LEFT' : 'RIGHT';
    const lines = file?.hunks.flatMap((h) => h.lines) ?? [];
    let line = lines.find((l) => side === 'LEFT' ? l.kind === 'del' && l.oldLine === f.location.startLine : l.kind !== 'del' && l.newLine === f.location.startLine);
    if (!line) { line = lines.find((l) => l.kind === 'del' && l.oldLine === f.location.startLine); side = 'LEFT'; }
    if (!file || !line) { skipped.push(`${f.location.file}:${f.location.startLine} — ${f.title}`); continue; }
    const semantic = stableId(f.ruleId, file.path, f.title, line.text.trim());
    const occurrence = occurrences.get(semantic) ?? 0;
    occurrences.set(semantic, occurrence + 1);
    const key = stableId(semantic, occurrence);
    const text = [`**${escapeMarkdown(redactSecrets(severityLabel(f.severity)))} · ${escapeMarkdown(redactSecrets(f.title))}**`, escapeMarkdown(redactSecrets(f.description)), tr('Evidence: {0}. {1}', escapeMarkdown(redactSecrets(verificationLabel(f.verification))), escapeMarkdown(redactSecrets(f.verificationNote))), ...(f.suggestedFix ? [tr('Suggested correction: {0}', escapeMarkdown(redactSecrets(f.suggestedFix)))] : [])].join('\n\n');
    comments.push({ key, path: file.path, line: f.location.startLine, side, body: `${commentMarker(key)}\n${redactSecrets(text)}` });
  }
  const groups = new Map<string, { readonly first: InlineDraft; readonly keys: string[]; readonly parts: string[] }>();
  for (const comment of comments) {
    const location = `${comment.path}:${comment.side}:${comment.line}`;
    const group = groups.get(location) ?? { first: comment, keys: [], parts: [] };
    const part = comment.body.slice(comment.body.indexOf('\n') + 1);
    if (part.length + group.parts.join('\n\n---\n\n').length > 59_000) { skipped.push(`${comment.path}:${comment.line}`); continue; }
    group.keys.push(comment.key); group.parts.push(part); groups.set(location, group);
  }
  const grouped: InlineDraft[] = [];
  for (const group of groups.values()) {
    if (grouped.length >= limit) { skipped.push(`${group.first.path}:${group.first.line}`); continue; }
    const key = stableId(...group.keys.sort());
    grouped.push({ ...group.first, key, body: `${commentMarker(key)}\n${group.parts.join('\n\n---\n\n')}` });
  }
  return { comments: grouped, skipped };
}

export interface ReviewThread {
  readonly id: string; readonly isResolved: boolean; readonly viewerCanResolve: boolean;
  readonly comments: readonly { readonly databaseId: number | null; readonly body: string; readonly url: string; readonly author: { readonly login: string } | null }[];
}
const ThreadCommentSchema = z.object({ databaseId: z.number().nullable(), body: z.string(), url: z.string(), author: z.object({ login: z.string() }).nullable() });
const CommentsSchema = z.object({ nodes: z.array(ThreadCommentSchema), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });
const ThreadSchema = z.object({ id: z.string(), isResolved: z.boolean(), viewerCanResolve: z.boolean(), comments: CommentsSchema });
const ThreadsSchema = z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(ThreadSchema), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }).nullable() }).nullable() });

function endpoint(ref: GitHubRepoRef): string {
  const name = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
  if (!name.test(ref.owner) || !name.test(ref.repo)) throw new GitHubError(tr('Invalid repository.'), undefined, 'invalid-response');
  return `/repos/${ref.owner}/${ref.repo}`;
}
function pullPath(ref: GitHubRepoRef, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new GitHubError(tr('Invalid pull request number.'), undefined, 'invalid-response');
  return `${endpoint(ref)}/pulls/${number}`;
}
export class GitHubDelivery {
  constructor(private readonly client: GitHubClient) {}
  user(signal?: AbortSignal): Promise<z.infer<typeof UserSchema>> { return this.client.rest('/user', UserSchema, 'GET', undefined, signal); }
  repository(ref: GitHubRepoRef, signal?: AbortSignal): Promise<RepositoryCapabilities> { return this.client.rest(endpoint(ref), RepoSchema, 'GET', undefined, signal); }
  pull(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<DeliveryPull> { return this.client.rest(pullPath(ref, number), DeliveryPullSchema, 'GET', undefined, signal); }
  async assertHead(ref: GitHubRepoRef, number: number, expectedSha: string, signal?: AbortSignal): Promise<DeliveryPull> {
    const pull = await this.pull(ref, number, signal);
    if (pull.head.sha !== expectedSha || pull.state !== 'open' || pull.merged) throw new GitHubError(tr('The pull request changed or is no longer open. Refresh and review the current commit before publishing.'), undefined, 'http');
    return pull;
  }
  async createOrUpdate(ref: GitHubRepoRef, input: { readonly title: string; readonly body: string; readonly head: string; readonly base: string; readonly draft: boolean; readonly expectedSha: string; readonly expectedNumber?: number }, signal?: AbortSignal): Promise<DeliveryPull> {
    // Look up the branch first: retry after an uncertain network response cannot create a second PR.
    const remote = await this.client.rest(`${endpoint(ref)}/git/ref/heads/${input.head.split('/').map(encodeURIComponent).join('/')}`, z.object({ object: z.object({ sha: z.string() }) }), 'GET', undefined, signal);
    if (remote.object.sha !== input.expectedSha) throw new GitHubError(tr('Push the reviewed commit before publishing this pull request.'), undefined, 'http');
    const existing = (await this.branchPulls(ref, input.head, signal)).filter((p) => p.base.ref === input.base);
    if (existing.length > 1) throw new GitHubError(tr('Several pull requests match this branch. Select one explicitly.'), undefined, 'http');
    if (existing[0]) {
      if (existing[0].number !== input.expectedNumber) throw new GitHubError(tr('The target pull request changed during confirmation. Refresh before publishing.'), undefined, 'http');
      await this.assertHead(ref, existing[0].number, input.expectedSha, signal);
      return this.update(ref, existing[0].number, input.title, input.body, signal);
    }
    if (input.expectedNumber !== undefined) throw new GitHubError(tr('The selected pull request is no longer open.'), undefined, 'http');
    const created = await this.client.rest(`${endpoint(ref)}/pulls`, DeliveryPullSchema, 'POST', { title: input.title, body: redactSecrets(input.body), head: input.head, base: input.base, draft: input.draft }, signal);
    if (created.head.sha !== input.expectedSha || created.base.ref !== input.base) throw new GitHubError(tr('The pull request was created, but its branch changed during publication. Refresh and review it before sharing evidence.'), undefined, 'http');
    return created;
  }
  branchPulls(ref: GitHubRepoRef, branch: string, signal?: AbortSignal): Promise<z.infer<typeof PullSchema>[]> {
    return this.client.paginate(`${endpoint(ref)}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${branch}`)}`, z.array(PullSchema), signal);
  }
  update(ref: GitHubRepoRef, number: number, title: string, body: string, signal?: AbortSignal): Promise<DeliveryPull> {
    return this.client.rest(pullPath(ref, number), DeliveryPullSchema, 'PATCH', { title: redactSecrets(title), body: redactSecrets(body) }, signal);
  }
  async setDraft(pull: DeliveryPull, draft: boolean, signal?: AbortSignal): Promise<void> {
    const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    await this.client.graphql(`mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id}}}`, { id: pull.node_id }, z.record(z.string(), z.unknown()), signal);
  }
  async status(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<DeliveryStatus> {
    const pull = await this.pull(ref, number, signal);
    const [repo, checkRuns, statuses] = await Promise.all([
      this.repository(ref, signal),
      this.listCheckRuns(ref, pull.head.sha, signal),
      this.client.paginate(`${endpoint(ref)}/commits/${encodeURIComponent(pull.head.sha)}/statuses`, z.array(StatusSchema), signal),
    ]);
    const checks = checkRuns.map((c) => ({ name: c.name, state: c.status === 'completed' ? c.conclusion ?? 'unknown' : c.status, url: c.details_url ?? c.html_url ?? null }));
    const latest = new Map<string, z.infer<typeof StatusSchema>>();
    for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, s);
    checks.push(...[...latest.values()].map((s) => ({ name: s.context, state: s.state, url: s.target_url })));
    const blockers: string[] = [];
    if (pull.state !== 'open' || pull.merged) blockers.push(tr('The pull request is not open.'));
    if (pull.draft) blockers.push(tr('The pull request is a draft.'));
    if (pull.mergeable !== true) blockers.push(pull.mergeable === false ? tr('Merge conflicts must be resolved.') : tr('GitHub is still calculating mergeability.'));
    if (!['clean', 'has_hooks'].includes(pull.mergeable_state)) blockers.push(tr('GitHub merge state: {0}. Branch requirements may be pending.', pull.mergeable_state));
    if (repo.permissions?.push !== true) blockers.push(tr('The signed-in account does not have merge permissions.'));
    const unfinished = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.state));
    if (unfinished.length) blockers.push(tr('{0} check(s) have not passed.', unfinished.length));
    const methods: MergeMethod[] = [];
    if (repo.allow_squash_merge) methods.push('squash');
    if (repo.allow_merge_commit) methods.push('merge');
    if (repo.allow_rebase_merge) methods.push('rebase');
    if (!methods.length) blockers.push(tr('No merge method is enabled.'));
    return { pull, checks, blockers, methods };
  }
  private async listCheckRuns(ref: GitHubRepoRef, sha: string, signal?: AbortSignal): Promise<z.infer<typeof CheckSchema>[]> {
    const values: z.infer<typeof CheckSchema>[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.client.rest(`${endpoint(ref)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100&page=${page}`, z.object({ check_runs: z.array(CheckSchema) }), 'GET', undefined, signal);
      values.push(...result.check_runs);
      if (result.check_runs.length < 100) return values;
    }
    throw new GitHubError(tr('Too many CI checks to determine readiness.'), undefined, 'invalid-response');
  }
  async merge(ref: GitHubRepoRef, number: number, expectedSha: string, method: MergeMethod, expectedBase: { readonly ref: string; readonly sha: string }, signal?: AbortSignal): Promise<string> {
    const status = await this.status(ref, number, signal);
    if (status.pull.head.sha !== expectedSha || status.pull.base.ref !== expectedBase.ref || status.pull.base.sha !== expectedBase.sha) throw new GitHubError(tr('The head commit changed. Refresh before merging.'), undefined, 'http');
    if (status.blockers.length || !status.methods.includes(method)) throw new GitHubError(status.blockers.join(' ') || tr('This merge method is disabled.'), undefined, 'http');
    // Query review requirements explicitly: an administrator's ability to bypass protections is not permission to do so.
    const policy = await this.client.graphql('query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewDecision mergeStateStatus}}}', { owner: ref.owner, repo: ref.repo, number }, z.object({ repository: z.object({ pullRequest: z.object({ headRefOid: z.string(), reviewDecision: z.string().nullable(), mergeStateStatus: z.string() }).nullable() }).nullable() }), signal);
    const latest = policy.repository?.pullRequest;
    if (!latest || latest.headRefOid !== expectedSha || ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(latest.reviewDecision ?? '') || !['CLEAN', 'HAS_HOOKS'].includes(latest.mergeStateStatus)) throw new GitHubError(tr('GitHub review requirements are not satisfied or the pull request changed. Refresh before merging.'), undefined, 'http');
    const result = await this.client.rest(`${pullPath(ref, number)}/merge`, z.object({ merged: z.boolean(), sha: z.string(), message: z.string() }), 'PUT', { sha: expectedSha, merge_method: method }, signal);
    if (!result.merged) throw new GitHubError(result.message, undefined, 'http');
    return result.sha;
  }
  async enqueue(ref: GitHubRepoRef, number: number, expectedSha: string, expectedBase: { readonly ref: string; readonly sha: string }, signal?: AbortSignal): Promise<void> {
    const pull = await this.assertHead(ref, number, expectedSha, signal);
    if (pull.base.ref !== expectedBase.ref || pull.base.sha !== expectedBase.sha) throw new GitHubError(tr('The target branch changed. Refresh and confirm the new destination.'), undefined, 'http');
    if (pull.draft || pull.mergeable === false) throw new GitHubError(tr('Drafts and conflicted pull requests cannot enter the merge queue.'), undefined, 'http');
    await this.client.graphql('mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{id}}}', { id: pull.node_id, sha: expectedSha }, z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: z.string() }).nullable() }) }), signal);
  }
  async publishReview(ref: GitHubRepoRef, number: number, expectedSha: string, draft: ReviewDraft, signal?: AbortSignal): Promise<{ readonly created: number; readonly updated: number }> {
    await this.assertHead(ref, number, expectedSha, signal);
    const [actor, existing] = await Promise.all([this.user(signal), this.client.paginate(`${pullPath(ref, number)}/comments`, z.array(ReviewCommentSchema), signal)]);
    let updated = 0;
    const missing: InlineDraft[] = [];
    for (const comment of draft.comments) {
      // A marker alone is never authority to edit. Comments made by another application or user are preserved.
      const current = existing.find((c) => c.user?.id === actor.id && !c.performed_via_github_app && c.body.startsWith(commentMarker(comment.key)) && c.path === comment.path && c.line === comment.line && (c.side ?? 'RIGHT') === comment.side && c.commit_id === expectedSha);
      if (!current) { missing.push(comment); continue; }
      if (current.body === comment.body) continue;
      await this.assertHead(ref, number, expectedSha, signal);
      await this.client.rest(`${endpoint(ref)}/pulls/comments/${current.id}`, ReviewCommentSchema, 'PATCH', { body: comment.body }, signal);
      updated++;
    }
    if (missing.length) {
      await this.assertHead(ref, number, expectedSha, signal);
      await this.client.rest(`${pullPath(ref, number)}/reviews`, z.object({ id: z.number() }), 'POST', { commit_id: expectedSha, event: 'COMMENT', body: `Probato PR: ${missing.length} selected finding(s). Evidence status is shown on every observation.`, comments: missing.map(({ path, line, side, body }) => ({ path, line, side, body })) }, signal);
    }
    return { created: missing.length, updated };
  }
  async review(ref: GitHubRepoRef, number: number, expectedSha: string, event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', body: string, signal?: AbortSignal): Promise<void> {
    const pull = await this.assertHead(ref, number, expectedSha, signal);
    const actor = await this.user(signal);
    if (event !== 'COMMENT' && actor.id === pull.user?.id) throw new GitHubError(tr('GitHub does not allow approving or requesting changes on your own pull request.'), undefined, 'http');
    await this.client.rest(`${pullPath(ref, number)}/reviews`, z.object({ id: z.number() }), 'POST', { commit_id: expectedSha, event, body: redactSecrets(body) }, signal);
  }
  async threads(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<ReviewThread[]> {
    pullPath(ref, number);
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: z.infer<typeof ThreadsSchema> = await this.client.graphql('query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved viewerCanResolve comments(first:100){nodes{databaseId body url author{login}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}', { owner: ref.owner, repo: ref.repo, number, after }, ThreadsSchema, signal);
      const connection: NonNullable<NonNullable<z.infer<typeof ThreadsSchema>['repository']>['pullRequest']>['reviewThreads'] | undefined = data.repository?.pullRequest?.reviewThreads;
      if (!connection) throw new GitHubError(tr('The pull request conversations are unavailable.'), undefined, 'not-found');
      for (const thread of connection.nodes) {
        const comments = [...thread.comments.nodes];
        let info = thread.comments.pageInfo;
        for (let commentPage = 0; info.hasNextPage; commentPage++) {
          if (commentPage >= 100 || !info.endCursor) throw new GitHubError(tr('Conversation pagination limit reached.'), undefined, 'invalid-response');
          const more = await this.client.graphql('query($id:ID!,$after:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{databaseId body url author{login}} pageInfo{hasNextPage endCursor}}}}}', { id: thread.id, after: info.endCursor }, z.object({ node: z.object({ comments: CommentsSchema }).nullable() }), signal);
          if (!more.node) throw new GitHubError(tr('The conversation is no longer available.'), undefined, 'not-found');
          comments.push(...more.node.comments.nodes);
          info = more.node.comments.pageInfo;
        }
        threads.push({ id: thread.id, isResolved: thread.isResolved, viewerCanResolve: thread.viewerCanResolve, comments });
      }
      if (!connection.pageInfo.hasNextPage) return threads;
      after = connection.pageInfo.endCursor;
      if (!after) break;
    }
    throw new GitHubError(tr('Too many conversations. Refresh a narrower pull request.'), undefined, 'invalid-response');
  }
  async reply(ref: GitHubRepoRef, number: number, commentId: number, body: string, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(commentId) || commentId < 1) throw new GitHubError(tr('Invalid comment.'), undefined, 'invalid-response');
    await this.client.rest(`${pullPath(ref, number)}/comments/${commentId}/replies`, z.object({ id: z.number() }), 'POST', { body: redactSecrets(body) }, signal);
  }
  async resolve(threadId: string, resolved: boolean, signal?: AbortSignal): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.client.graphql(`mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id isResolved}}}`, { id: threadId }, z.record(z.string(), z.unknown()), signal);
  }
}
