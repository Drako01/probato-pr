export type PublishKind = 'published' | 'inactive' | 'fatal' | 'retry';

export interface RegistryResponse {
  json(): Promise<{ error?: string; version?: string }>;
}

export type FetchLike = (url: string) => Promise<RegistryResponse>;

export function classify(output: string, exitCode: number): PublishKind;

export function parseArgs(argv: readonly string[]): { mode: 'publish'; vsix: string; version?: string; trustedPublishing?: boolean } | { mode: 'check'; version: string };

export function publishWithRetry(options: {
  run: () => Promise<{ code: number; output: string }>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  attempts?: number;
  baseDelayMs?: number;
}): Promise<'published' | 'inactive'>;

export function isActive(options: { url: string; version: string; fetchImpl: FetchLike }): Promise<boolean>;

export function waitUntilActive(options: {
  url: string;
  version: string;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean>;

export function publishInvocation(vsix: string, trustedPublishing: boolean, environment?: Record<string, string | undefined>): { args: string[]; env: Record<string, string | undefined> };
