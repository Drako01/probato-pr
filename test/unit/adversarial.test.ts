/**
 * Red-team suite: hostile inputs against the trust boundaries listed in docs/THREAT_MODEL.md. Each block names the
 * attack it reproduces. Vectors already covered elsewhere are referenced in the threat model, not repeated here.
 */
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderError } from '../../src/ai/ai-provider';
import { InvalidBaseUrlError, OpenAiCompatibleProvider, parseAiBaseUrl } from '../../src/ai/openai-compatible-provider';
import { PathOutsideWorkspaceError, resolveInside } from '../../src/core/paths';
import { toSpawnInvocation, UnsafeCommandError } from '../../src/infrastructure/process-runner';
import { webviewMessageSchema } from '../../src/ui/summary-protocol';
import { tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

describe('exfiltration through an AI endpoint redirect', () => {
  it('never follows a 307 that would resend repository data to another server', async () => {
    let exfiltrated = 0;
    const attacker = createServer((_req, res) => {
      exfiltrated++;
      res.end('{}');
    });
    const attackerPort = await listen(attacker);
    const endpoint = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${attackerPort}/v1/chat/completions` });
      res.end();
    });
    const endpointPort = await listen(endpoint);
    cleanups.push(() => attacker.close(), () => endpoint.close());

    const provider = new OpenAiCompatibleProvider(parseAiBaseUrl(`http://127.0.0.1:${endpointPort}/v1`), 'm', () => Promise.resolve('sk-secret'));
    const error = await provider.complete({ instructions: 'review', data: 'repository code' }, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).message).toMatch(/redirect/);
    expect(exfiltrated).toBe(0);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data', // cloud metadata over plain http
    'http://localhost.attacker.example/v1', // loopback look-alike
    'http://127.0.0.1.nip.io/v1',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://key@api.example.com/v1',
    'https://api.example.com/v1#frag',
  ])('refuses the SSRF-shaped base URL %s', (raw) => {
    expect(() => parseAiBaseUrl(raw)).toThrow(InvalidBaseUrlError);
  });
});

describe('path traversal and symlinked parents', () => {
  it.each(['C:outside.txt', 'z:outside.txt', '\\outside.txt', 'C:\\outside.txt', '/etc/passwd'])(
    'refuses the rooted or drive-prefixed path %s on every platform',
    async (relative) => {
      const { dir, cleanup } = tempDir();
      cleanups.push(cleanup);
      await expect(resolveInside(dir, relative)).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    },
  );

  it.each(['..\\..\\outside.txt', '\\\\server\\share\\x', 'a/b/../../../outside.txt'])('never resolves %s outside the root', async (relative) => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const resolved = await resolveInside(dir, relative).catch((e: unknown) => e);
    if (resolved instanceof PathOutsideWorkspaceError) return;
    // A backslash is a file-name character on POSIX: the answer must then be inside the root.
    expect(typeof resolved).toBe('string');
    // `.native` matches the implementation's realpath: the JS fallback keeps 8.3 short names (C:\Users\RUNNER~1)
    // on Windows, which would make an inside path look outside.
    const rel = path.relative(realpathSync.native(dir), resolved as string);
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(false);
  });

  it('rejects a path that does not exist yet below a parent symlinked outside the repository', async () => {
    const outside = tempDir();
    const inside = tempDir();
    cleanups.push(outside.cleanup, inside.cleanup);
    symlinkSync(outside.dir, path.join(inside.dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveInside(inside.dir, 'link/new.txt')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(resolveInside(inside.dir, 'link/deeper/new.txt')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('re-checks on every call, so a directory swapped for a symlink after a first check is refused (TOCTOU)', async () => {
    const outside = tempDir();
    const inside = tempDir();
    cleanups.push(outside.cleanup, inside.cleanup);
    mkdirSync(path.join(inside.dir, 'swap'));
    writeFileSync(path.join(inside.dir, 'swap', 'a.txt'), 'x');
    await expect(resolveInside(inside.dir, 'swap/a.txt')).resolves.toMatch(/a\.txt$/);
    writeFileSync(path.join(outside.dir, 'a.txt'), 'secret');
    const moved = path.join(inside.dir, 'gone');
    renameSync(path.join(inside.dir, 'swap'), moved);
    symlinkSync(outside.dir, path.join(inside.dir, 'swap'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveInside(inside.dir, 'swap/a.txt')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });
});

describe('cmd.exe argument injection on Windows shims', () => {
  it.each(['a>out.txt', 'a<in.txt', '(calc)', '!PATH!', 'a\nb', 'a\r\ncalc', 'a b', '', '"', "a'b", 'a`b', 'a;b'])('rejects %j', (arg) => {
    expect(() => toSpawnInvocation({ executable: 'npm', args: ['run', arg] }, 'win32')).toThrow(UnsafeCommandError);
  });
});

describe('webview message abuse', () => {
  it.each([
    { type: 'command', command: 'workbench.action.terminal.new' },
    { type: 'command', command: 'vscode.open' },
    { type: 'runShell', cmd: 'calc' },
    { type: 'openFinding', id: 'x'.repeat(201) },
    { type: 'openFinding', id: '' },
    { type: 'openFinding' },
    { type: '__proto__' },
    'command',
    null,
  ])('rejects %j', (message) => {
    expect(webviewMessageSchema.safeParse(message).success).toBe(false);
  });

  it('drops unknown fields instead of forwarding them', () => {
    const parsed = webviewMessageSchema.parse({ type: 'openFinding', id: 'f1', command: 'workbench.action.terminal.new' });
    expect(parsed).toEqual({ type: 'openFinding', id: 'f1' });
  });
});
