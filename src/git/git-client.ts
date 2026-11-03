import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ProcessRunner, RunResult } from '../infrastructure/process-runner';

/** Git's well-known empty tree object, used as the base for root commits and unborn branches. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Global options applied to every git invocation. Repository config is untrusted input: these
 * disable config-driven command execution (fsmonitor hooks, external diff drivers, textconv,
 * pagers) and keep output stable regardless of the user's diff settings.
 */
const SAFE_GLOBAL_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotePath=false',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'color.ui=false',
];

export const SAFE_DIFF_ARGS: readonly string[] = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--unified=3',
];


const REF_PATTERN =/^(?!-)(?!.*\.\.)[\w./@^~:-]+$/;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitNotFoundError extends Error {
  constructor(detail: string) {
    super(`Git executable not available: ${detail}`);
    this.name = 'GitNotFoundError';
  }
}

export class OutputTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Git output exceeded the configured limit of ${limitBytes} bytes.`);
    this.name = 'OutputTooLargeError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
    this.name = 'CancelledError';
  }
}

/** Rejects refs that could be parsed as options or contain shell/rev-parse surprises. */
export function assertSafeRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new GitError(`Unsafe git reference "${ref}".`, [], '', null);
  }
  return ref;
}

export interface GitExecOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly allowExitCodes?: readonly number[];
}

export class GitClient {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly defaults: { readonly timeoutMs: number; readonly maxBytes: number },
  ) {}

  async exec(cwd: string, args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    const maxBytes = options.maxBytes ?? this.defaults.maxBytes;
    const result: RunResult = await this.runner.run(
      { executable: 'git', args: [...SAFE_GLOBAL_ARGS, ...args] },
      {
        cwd,
        timeoutMs: this.defaults.timeoutMs,
        maxOutputBytes: maxBytes,
        capture: 'full',
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (result.cancelled) {
      throw new CancelledError();
    }
    if (result.spawnError) {
      throw new GitNotFoundError(result.spawnError);
    }
    if (result.truncated) {
      throw new OutputTooLargeError(maxBytes);
    }
    if (result.timedOut) {
      throw new GitError(`git ${args[0] ?? ''} timed out.`, args, result.stderr, null);
    }
    const allowed = options.allowExitCodes ?? [0];
    if (result.exitCode === null || !allowed.includes(result.exitCode)) {
      throw new GitError(
        `git ${args[0] ?? ''} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().split('\n')[0] ?? ''}`,
        args,
        result.stderr,
        result.exitCode,
      );
    }
    return result.stdout;
  }

  private async tryExec(cwd: string, args: readonly string[]): Promise<string | undefined> {
    try {
      return (await this.exec(cwd, args)).trim();
    } catch (error) {
      if (error instanceof GitError) {
        return undefined;
      }
      throw error;
    }
  }

  async topLevel(dir: string): Promise<string | undefined> {
    return this.tryExec(dir, ['rev-parse', '--show-toplevel']);
  }

  async currentBranch(root: string): Promise<string | undefined> {
    return this.tryExec(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  async resolveCommit(root: string, ref: string): Promise<string | undefined> {
    return this.tryExec(root, ['rev-parse', '--verify', '--quiet', `${assertSafeRef(ref)}^{commit}`]);
  }

  async mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
    return this.tryExec(root, ['merge-base', assertSafeRef(a), assertSafeRef(b)]);
  }

  async remoteUrl(root: string, remote = 'origin'): Promise<string | undefined> {
    return this.tryExec(root, ['remote', 'get-url', assertSafeRef(remote)]);
  }

  async isDirty(root: string): Promise<boolean> {
    const out = await this.exec(root, ['status', '--porcelain', '--untracked-files=no']);
    return out.trim().length > 0;
  }

  /** Base branch: explicit setting, then origin/HEAD, then common names that exist. */
  async defaultBaseBranch(root: string, configured: string): Promise<string | undefined> {
    if (configured) {
      return (await this.resolveCommit(root, configured)) ? configured : undefined;
    }
    const originHead = await this.tryExec(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (originHead) {
      return originHead;
    }
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']) {
      if (await this.resolveCommit(root, candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  async diff(root: string, args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    return this.exec(root, ['diff', ...SAFE_DIFF_ARGS, ...args], options);
  }

  async untrackedFiles(root: string): Promise<string[]> {
    const out = await this.exec(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    return out.split('\0').filter((p) => p.length > 0);
  }

  /** Blob content at a revision ("HEAD", a sha, or "" for the index); undefined when absent. */
  async readBlob(root: string, revision: string, path: string, maxBytes: number): Promise<string | undefined> {
    const spec = revision === '' ? `:${path}` : `${assertSafeRef(revision)}:${path}`;
    try {
      return await this.exec(root, ['cat-file', 'blob', spec], { maxBytes });
    } catch (error) {
      if (error instanceof GitError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Checkout/apply cannot invoke repo-configured filter commands or hooks. */
  async execWithoutCheckoutCode(root: string, args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    const configured = await this.exec(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { allowExitCodes: [0, 1] });
    const overrides: string[] = [];
    for (const key of configured.split('\0').filter(Boolean)) {
      if (!/^filter\.[\w.-]+\.(clean|smudge|process|required)$/i.test(key)) throw new GitError('Invalid checkout filter configuration.', [], '', null);
      overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    const hooks = await mkdtemp(path.join(tmpdir(), 'probato-empty-hooks-'));
    try { return await this.exec(root, ['-c', `core.hooksPath=${hooks}`, ...overrides, ...args], options); }
    finally { await rmdir(hooks); }
  }

  async addDetachedWorktree(root: string, target: string, commit: string): Promise<void> {
    await this.execWithoutCheckoutCode(root, ['worktree', 'add', '--detach', '--force', target, assertSafeRef(commit)]);
  }

  async removeWorktree(root: string, target: string): Promise<void> {
    await this.exec(root, ['worktree', 'remove', '--force', target], { allowExitCodes: [0, 128] });
    await this.exec(root, ['worktree', 'prune'], { allowExitCodes: [0, 128] });
  }
}
