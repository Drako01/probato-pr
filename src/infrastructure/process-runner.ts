import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CommandSpec } from '../core/model';

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /**
   * 'full' keeps stdout from the start and fails when it exceeds the limit (machine-readable output such as diffs);
   * 'tail' keeps the last bytes of combined stdout+stderr (human-readable check logs).
   */
  readonly capture: 'full' | 'tail';
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Combined stdout+stderr, tail-limited. */
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputSha256: string;
  readonly spawnError?: string;
}

export interface ProcessRunner {
  run(command: CommandSpec, options: RunOptions): Promise<RunResult>;
}

/** Executables distributed as .cmd shims on Windows; Node refuses to spawn them without a shell. */
const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
/** Arguments allowed through cmd.exe: no metacharacters that the shell could interpret. */
const SAFE_SHELL_ARG = /^[\w:./=@+-]+$/;

export class UnsafeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCommandError';
  }
}

export function toSpawnInvocation(
  command: CommandSpec,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32' && WINDOWS_SHIMS.has(command.executable)) {
    for (const arg of command.args) {
      if (!SAFE_SHELL_ARG.test(arg)) {
        throw new UnsafeCommandError(`Argument "${arg}" cannot be passed safely through cmd.exe.`);
      }
    }
    return { file: 'cmd.exe', args: ['/d', '/c', command.executable, ...command.args] };
  }
  return { file: command.executable, args: [...command.args] };
}

export function formatCommandLine(command: CommandSpec): string {
  return [command.executable, ...command.args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

const KILL_GRACE_MS = 3000;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    // taskkill /T terminates the whole tree (test runners spawn workers that would otherwise survive).
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
      child.kill();
    });
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM'); // negative pid: the detached process group
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }, KILL_GRACE_MS).unref();
}

/** Non-interactive, colorless environment so tools neither prompt, watch, nor emit ANSI codes. */
export function buildChildEnv(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

export class NodeProcessRunner implements ProcessRunner {
  run(command: CommandSpec, options: RunOptions): Promise<RunResult> {
    const startedAt = new Date();
    const hash = createHash('sha256');
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let tail: Buffer[] = [];
    let tailBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (partial: Partial<RunResult>): RunResult => ({
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      output: Buffer.concat(tail).toString('utf8'),
      truncated,
      timedOut,
      cancelled,
      outputSha256: hash.digest('hex'),
      ...partial,
    });

    if (options.signal?.aborted) {
      cancelled = true;
      return Promise.resolve(finish({ spawnError: 'Cancelled before start.' }));
    }

    let invocation: { file: string; args: string[] };
    try {
      invocation = toSpawnInvocation(command);
    } catch (error) {
      return Promise.resolve(finish({ spawnError: (error as Error).message }));
    }

    return new Promise<RunResult>((resolve) => {
      const child = spawn(invocation.file, invocation.args, {
        cwd: options.cwd,
        env: buildChildEnv(options.env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const appendTail = (chunk: Buffer): void => {
        tail.push(chunk);
        tailBytes += chunk.length;
        while (tailBytes > options.maxOutputBytes && tail.length > 1) {
          const dropped = tail.shift();
          tailBytes -= dropped?.length ?? 0;
          truncated = true;
        }
        if (tailBytes > options.maxOutputBytes && tail.length === 1 && tail[0]) {
          tail = [tail[0].subarray(tail[0].length - options.maxOutputBytes)];
          tailBytes = options.maxOutputBytes;
          truncated = true;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (options.capture === 'full') {
          stdoutBytes += chunk.length;
          if (stdoutBytes > options.maxOutputBytes) {
            truncated = true;
            killTree(child);
            return;
          }
          stdoutChunks.push(chunk);
        }
        appendTail(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (stderrBytes < options.maxOutputBytes) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
        appendTail(chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        killTree(child);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      // 'error' and 'close' can both fire (e.g. ENOENT); only the first one builds the result.
      let settled = false;
      const settle = (partial: Partial<RunResult>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(finish(partial));
      };

      child.on('error', (error) => {
        settle({ spawnError: error.message });
      });
      child.on('close', (code, signal) => {
        settle({ exitCode: code, signal });
      });
    });
  }
}
