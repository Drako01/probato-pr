import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob } from '../../src/core/glob';
import { PathOutsideWorkspaceError, resolveInside } from '../../src/core/paths';
import { findSecrets, redactSecrets } from '../../src/core/secrets';
import { tempDir } from './helpers';

describe('glob', () => {
  it.each([
    ['src/node_modules/x/y.js', '**/node_modules/**', true],
    ['node_modules/x.js', '**/node_modules/**', true],
    ['src/app.min.js', '**/*.min.js', true],
    ['src/app.js', '**/*.min.js', false],
    ['.env', '**/.env', true],
    ['config/.env.production', '**/.env.*', true],
    ['src/a.ts', 'src/*.{ts,tsx}', true],
    ['src/deep/a.ts', 'src/*.ts', false],
  ])('%s vs %s → %s', (p, g, expected) => {
    expect(matchesGlob(p, g)).toBe(expected);
  });

  it('matches any of several globs', () => {
    expect(matchesAnyGlob('a/b.pem', ['**/*.key', '**/*.pem'])).toBe(true);
  });
});

describe('secrets', () => {
  // Built from parts so this test file never contains a literal credential.
  const ghToken = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

  it('detects known token formats', () => {
    expect(findSecrets(`const t = "${ghToken}";`).map((m) => m.pattern.id)).toContain('github-token');
    expect(findSecrets(`aws=${awsKey}`).map((m) => m.pattern.id)).toContain('aws-access-key');
    expect(findSecrets('postgres://admin:hunter22@db:5432/app').map((m) => m.pattern.id)).toContain('connection-string-password');
  });

  it('ignores placeholders in generic assignments', () => {
    expect(findSecrets('password: "changeme"')).toHaveLength(0);
    expect(findSecrets('apiKey = "${API_KEY}"')).toHaveLength(0);
    expect(findSecrets('password: "Sup3rS3cretValue!"').map((m) => m.pattern.id)).toContain('generic-secret-assignment');
  });

  it('redacts secrets while keeping surrounding text', () => {
    const redacted = redactSecrets(`token=${ghToken} ok`);
    expect(redacted).toBe('token=[REDACTED:github-token] ok');
    expect(redacted).not.toContain(ghToken);
  });
});

describe('resolveInside', () => {
  const temps: (() => void)[] = [];
  afterEach(() => {
    temps.splice(0).forEach((c) => {
      c();
    });
  });

  it('resolves normal relative paths', async () => {
    const { dir, cleanup } = tempDir();
    temps.push(cleanup);
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    await expect(resolveInside(dir, 'a.txt')).resolves.toMatch(/a\.txt$/);
    await expect(resolveInside(dir, 'missing/new.txt')).resolves.toMatch(/new\.txt$/);
  });

  it.each(['../outside.txt', 'a/../../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\0b'])('rejects %s', async (p) => {
    const { dir, cleanup } = tempDir();
    temps.push(cleanup);
    await expect(resolveInside(dir, p)).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('rejects symlinks that escape the root', async () => {
    const outside = tempDir();
    const inside = tempDir();
    temps.push(outside.cleanup, inside.cleanup);
    writeFileSync(path.join(outside.dir, 'secret.txt'), 'top secret');
    mkdirSync(path.join(inside.dir, 'sub'));
    symlinkSync(outside.dir, path.join(inside.dir, 'sub', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveInside(inside.dir, 'sub/link/secret.txt')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });
});
