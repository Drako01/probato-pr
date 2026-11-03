import { tr } from '../core/i18n';
import type { ReadableStreamReadResult } from 'node:stream/web';
import { z } from 'zod';

export interface GitHubRepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** GitHub owner/repo names; dot-only names are rejected so they cannot traverse API URL paths. */
const NAME = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;

/** Parses github.com remotes (https, ssh, scp-like). Returns undefined for other hosts. */
export function parseGitHubRemote(url: string): GitHubRepoRef | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match?.[1] || !match[2] || !NAME.test(match[1]) || !NAME.test(match[2])) {
    return undefined;
  }
  return { owner: match[1], repo: match[2] };
}

export const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ sha: z.string(), ref: z.string() }),
});
export type PullRequest = z.infer<typeof PullSchema>;

const PullFileSchema = z.object({
  filename: z.string(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});
export type PullFile = z.infer<typeof PullFileSchema>;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly kind: 'unauthorized' | 'not-found' | 'rate-limited' | 'network' | 'invalid-response' | 'http',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FILE_PAGES = 30; // 30 × 100 = GitHub's 3000-file ceiling for this endpoint

/** Minimal read-only GitHub REST client. Tokens come from VS Code's GitHub authentication provider. */
export class GitHubClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly token: () => Promise<string | undefined>,
  ) {}

  private async request(path: string, accept: string, signal?: AbortSignal, method = 'GET', body?: unknown): Promise<Response> {
    const token = await this.token();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${API}${path}`, {
        method,
        redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'probato-pr-vscode',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new GitHubError(tr('Could not reach GitHub ({0}). Local reviews keep working offline.', error instanceof Error ? error.message : String(error)), undefined, 'network');
    }
    if (response.ok) {
      return response;
    }
    if (response.status === 401) {
      throw new GitHubError(tr('GitHub rejected the credentials (401). Sign in again.'), 401, 'unauthorized');
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) ? new Date(reset * 1000).toLocaleTimeString() : tr('later');
      throw new GitHubError(tr('GitHub API rate limit reached; it resets at {0}. Signing in raises the limit.', when), response.status, 'rate-limited');
    }
    if (response.status === 404) {
      throw new GitHubError(tr('Not found on GitHub. For private repositories, sign in with an account that has access.'), 404, 'not-found');
    }
    throw new GitHubError(tr('GitHub request failed with HTTP {0}. The action may be blocked by permissions, branch protections or a changed pull request. Refresh before retrying.', response.status), response.status, 'http');
  }

  private async json<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, 'application/vnd.github+json', signal);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubError(tr('Unexpected GitHub response for {0}.', path), response.status, 'invalid-response');
    }
    return parsed.data;
  }

  async listOpenPulls(ref: GitHubRepoRef, signal?: AbortSignal): Promise<PullRequest[]> {
    return this.paginate(`/repos/${ref.owner}/${ref.repo}/pulls?state=open`, z.array(PullSchema), signal);
  }

  getPull(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<PullRequest> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/pulls/${number}`, PullSchema, signal);
  }

  async listPullFiles(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<PullFile[]> {
    const files: PullFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.json(`/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=100&page=${page}`, z.array(PullFileSchema), signal);
      files.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    if (files.length === MAX_FILE_PAGES * 100) throw new GitHubError(tr('GitHub returned the maximum number of pull request files; this review would be incomplete.'), undefined, 'invalid-response');
    return files;
  }


  /** Bounded, complete pagination. Reaching the ceiling is an error, never a silent partial result. */
  async paginate<T>(endpoint: string, schema: z.ZodType<T[]>, signal?: AbortSignal): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.json(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, schema, signal);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new GitHubError(tr('GitHub pagination limit reached. Narrow the selection before continuing.'), undefined, 'invalid-response');
  }

  /** JSON transport shared by delivery actions. Requests always target api.github.com; redirects are refused. */
  async rest<T>(endpoint: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!endpoint.startsWith('/') || endpoint.includes('://') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(endpoint)) {
      throw new GitHubError(tr('Invalid GitHub API path.'), undefined, 'invalid-response');
    }
    const response = await this.request(endpoint, 'application/vnd.github+json', signal, method, body);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new GitHubError(tr('GitHub returned an invalid delivery response.'), response.status, 'invalid-response');
    return parsed.data;
  }

  async graphql<T>(query: string, variables: Readonly<Record<string, unknown>>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const envelope = await this.rest('/graphql', z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() }), 'POST', { query, variables }, signal);
    if (envelope.errors?.length) throw new GitHubError(tr('GitHub could not complete this action. Check repository permissions and branch requirements, then refresh.'), undefined, 'http');
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw new GitHubError(tr('GitHub returned incomplete delivery data.'), undefined, 'invalid-response');
    return parsed.data;
  }

  /** Actions logs redirect to signed storage. Follow that one redirect without forwarding the GitHub token. */
  async jobLog(ref: GitHubRepoRef, jobId: number, signal?: AbortSignal): Promise<string> {
    if (!NAME.test(ref.owner) || !NAME.test(ref.repo) || !Number.isSafeInteger(jobId) || jobId < 1) throw new GitHubError(tr('Invalid job.'), undefined, 'invalid-response');
    const token = await this.token();
    const timeout = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response = await this.fetchFn(`${API}/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`, { redirect: 'manual', headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: combined });
    if (response.status === 302) {
      const location = response.headers.get('location');
      if (!location || new URL(location).protocol !== 'https:') throw new GitHubError(tr('GitHub returned an invalid log download URL.'), response.status, 'invalid-response');
      response = await this.fetchFn(location, { redirect: 'error', signal: combined });
    }
    if (!response.ok) throw new GitHubError(tr('CI logs are unavailable. Check Actions read permissions and log retention.'), response.status, 'http');
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < 1_000_000) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        const bounded = chunk.value.subarray(0, 1_000_000 - bytes);
        chunks.push(bounded); bytes += bounded.byteLength;
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8') + (bytes >= 1_000_000 ? `\n${tr('[Log truncated at 1 MB]')}` : '');
  }

  async mergeBase(ref: GitHubRepoRef, base: string, head: string, signal?: AbortSignal): Promise<string> {
    const result = await this.json(`/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, z.object({ merge_base_commit: z.object({ sha: z.string().min(1) }) }), signal);
    return result.merge_base_commit.sha;
  }

  /** Raw file content at a commit; undefined when the file does not exist there or is too large. */
  async getFileContent(ref: GitHubRepoRef, path: string, sha: string, maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    try {
      const response = await this.request(`/repos/${ref.owner}/${ref.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`, 'application/vnd.github.raw+json', signal);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        return undefined;
      }
      const text = await response.text();
      return text.length > maxBytes ? undefined : text;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }
}
