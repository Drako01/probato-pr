import { describe, expect, it } from 'vitest';
import { compareDependencyInputs, type DependencyProbe } from '../../src/verification/dependency-comparability';
function probe(files: Readonly<Record<string, string>>, dirs: readonly string[] = []): DependencyProbe { return { readText: (file) => Promise.resolve(files[file]), exists: (file) => Promise.resolve(dirs.includes(file)) }; }
const manifest = JSON.stringify({ devDependencies: { dep: '1.0.0' } });
const identity = { version: '1.0.0', resolved: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz', integrity: 'sha512-test' };
const npmLock = JSON.stringify({ lockfileVersion: 3, packages: { '': { devDependencies: { dep: '1.0.0' } }, 'node_modules/dep': identity } });
const installedFiles = { 'package.json': manifest, 'package-lock.json': npmLock, 'node_modules/.package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/dep': identity } }), 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }) };
const files = { 'package.json': manifest, 'package-lock.json': npmLock };
describe('dependency reproducibility before baseline attribution', () => {
  it('accepts scripts using builtins with no declared or installed dependencies', async () => {
    const empty = probe({ 'package.json': JSON.stringify({ scripts: { test: 'node builtin.cjs' } }) });
    expect((await compareDependencyInputs(empty, empty, empty, '')).status).toBe('comparable');
  });
  it('accepts matching npm inputs, installed metadata and actual package version', async () => {
    const comparison = await compareDependencyInputs(probe(files), probe(files), probe(installedFiles, ['node_modules']), '');
    expect(comparison.status).toBe('comparable');
    expect(comparison.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects a lockfile-only change before comparing process outcomes', async () => {
    const comparison = await compareDependencyInputs(probe(files), probe({ ...files, 'package-lock.json': npmLock.replace('1.0.0', '0.9.0') }), probe(installedFiles, ['node_modules']), '');
    expect(comparison.status).toBe('inconclusive');
    expect(comparison.reasons.join(' ')).toMatch(/head and base: package-lock.json/);
    expect(comparison.reasons.join(' ')).toMatch(/does not install dependencies/);
  });
  it('rejects stale installed package identities even when the lockfiles match', async () => {
    const comparison = await compareDependencyInputs(probe(files), probe(files), probe({ ...installedFiles, 'node_modules/dep/package.json': '{"version":"0.9.0"}' }, ['node_modules']), '');
    expect(comparison.status).toBe('inconclusive');
    expect(comparison.reasons.join(' ')).toMatch(/identities do not match/);
  });
  it('rejects installed metadata absence and an unrelated checkout dependency manifest', async () => {
    const absent = await compareDependencyInputs(probe(files), probe(files), probe(files, ['node_modules']), '');
    expect(absent.status).toBe('inconclusive');
    const wrong = await compareDependencyInputs(probe(files), probe(files), probe({ ...installedFiles, 'package.json': '{"devDependencies":{"dep":"9"}}' }, ['node_modules']), '');
    expect(wrong.reasons.join(' ')).toMatch(/Installed checkout dependency inputs differ/);
  });
  it('compares pnpm lock metadata structurally and refuses mismatched versions', async () => {
    const lock = 'lockfileVersion: "9.0"\nimporters:\n  .:\n    devDependencies:\n      dep: {specifier: 1.0.0, version: 1.0.0}\n';
    const source = { 'package.json': manifest, 'pnpm-lock.yaml': lock };
    const comparison = await compareDependencyInputs(probe(source), probe(source), probe({ ...source, 'node_modules/.pnpm/lock.yaml': lock }, ['node_modules']), '');
    expect(comparison.status).toBe('comparable');
    const mismatch = await compareDependencyInputs(probe(source), probe(source), probe({ ...source, 'node_modules/.pnpm/lock.yaml': lock.replaceAll('1.0.0', '2.0.0') }, ['node_modules']), '');
    expect(mismatch.status).toBe('inconclusive');
  });
  it('does not treat unrelated sibling package changes as this package dependency input', async () => {
    const head = probe({ 'packages/a/package.json': '{}', 'packages/b/package.json': '{"dependencies":{"dep":"9"}}' });
    const base = probe({ 'packages/a/package.json': '{}', 'packages/b/package.json': '{}' });
    expect((await compareDependencyInputs(head, base, head, 'packages/a')).status).toBe('comparable');
  });
  it('does not claim environment equivalence for uninspected external ecosystem dependencies', async () => {
    const go = probe({ 'go.mod': 'module example.test/app\ngo 1.22\nrequire example.test/lib v1.0.0' });
    expect((await compareDependencyInputs(go, go, go, '')).status).toBe('inconclusive');
    const builtin = probe({ 'go.mod': 'module example.test/app\ngo 1.22' });
    expect((await compareDependencyInputs(builtin, builtin, builtin, '')).status).toBe('comparable');
  });
  it('fails closed on traversal and unreadable metadata', async () => {
    const empty = probe({});
    expect((await compareDependencyInputs(empty, empty, empty, '../escape')).status).toBe('inconclusive');
    const unreadable = { ...empty, readText: () => Promise.reject(new Error('read denied')) };
    expect((await compareDependencyInputs(unreadable, empty, empty, '')).reasons.join(' ')).toMatch(/read denied/);
  });
});
