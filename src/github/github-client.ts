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

const PullSchema = z.object({
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

  private async request(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.token();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${API}${path}`, {
        headers: {
          Accept: accept,
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
      throw new GitHubError(`Could not reach GitHub (${error instanceof Error ? error.message : String(error)}). Local reviews keep working offline.`, undefined, 'network');
    }
    if (response.ok) {
      return response;
    }
    if (response.status === 401) {
      throw new GitHubError('GitHub rejected the credentials (401). Sign in again.', 401, 'unauthorized');
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) ? new Date(reset * 1000).toLocaleTimeString() : 'later';
      throw new GitHubError(`GitHub API rate limit reached; it resets at ${when}. Signing in raises the limit.`, response.status, 'rate-limited');
    }
    if (response.status === 404) {
      throw new GitHubError('Not found on GitHub. For private repositories, sign in with an account that has access.', 404, 'not-found');
    }
    throw new GitHubError(`GitHub request failed with HTTP ${response.status}.`, response.status, 'http');
  }

  private async json<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, 'application/vnd.github+json', signal);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubError(`Unexpected GitHub response for ${path}.`, response.status, 'invalid-response');
    }
    return parsed.data;
  }

  listOpenPulls(ref: GitHubRepoRef, signal?: AbortSignal): Promise<PullRequest[]> {
    return this.json(`/repos/${ref.owner}/${ref.repo}/pulls?state=open&per_page=50`, z.array(PullSchema), signal);
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
    return files;
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
