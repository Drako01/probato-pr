import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CrossStackAnalyzer } from '../../src/analyzers/cross-stack';
import { parseCliArgs, runCli } from '../../src/cli';
import type { Analyzer } from '../../src/core/analyzer';
import { ReviewEngine } from '../../src/core/review-engine';
import { ReviewCache, withIncrementalCache } from '../../src/infrastructure/review-cache';
import { importSarif } from '../../src/reports/sarif-import';
import { detectProjectChecks } from '../../src/verification/monorepo-checks';
import { changeSetOf, git, initRepo, tempDir, workspaceOf, writeFiles } from './helpers';

const noChanges = () => changeSetOf([]);

describe('monorepo verification discovery', () => {
  it('finds nested JS, Go and PHP projects, preserving package-relative commands and snapshot identity', async () => {
    const files: Record<string, string> = {
      'package.json': '{"workspaces":["apps/*"]}',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'apps/web/package.json': '{"scripts":{"typecheck":"tsc --noEmit"}}',
      'services/api/go.mod': 'module example/api\n',
      'services/php/composer.json': '{"scripts":{"test":"phpunit"}}',
      'node_modules/evil/package.json': '{"scripts":{"test":"evil"}}',
    };
    const tree = { readText: (file: string) => Promise.resolve(files[file]), exists: (file: string) => Promise.resolve(files[file] !== undefined), listFiles: () => Promise.resolve(Object.keys(files)) };
    const before = await detectProjectChecks(tree, 'linux', 'snapshot-a');
    const after = await detectProjectChecks(tree, 'linux', 'snapshot-b');
    expect(before.find((check) => check.id === 'apps/web:script:typecheck')?.cwd).toBe('apps/web');
    expect(before.find((check) => check.id === 'apps/web:script:typecheck')?.command.executable).toBe('pnpm');
    expect(before.filter((check) => check.cwd === 'services/api')).toHaveLength(3);
    expect(before.find((check) => check.id === 'services/php:composer:test')?.command.executable).toBe('composer');
    expect(before.some((check) => check.cwd.includes('evil'))).toBe(false);
    expect(after.map((check) => check.fingerprint)).not.toEqual(before.map((check) => check.fingerprint));
    files['.npmrc'] = 'enable-pre-post-scripts=true';
    const reconfigured = await detectProjectChecks(tree, 'linux', 'snapshot-a');
    expect(reconfigured.find((check) => check.cwd === 'apps/web')?.fingerprint).not.toBe(before.find((check) => check.cwd === 'apps/web')?.fingerprint);
  });

  it('rejects an unbounded project tree instead of silently skipping projects', async () => {
    await expect(detectProjectChecks({ listFiles: () => Promise.resolve(Array.from({ length: 201 }, (_, i) => `p${i}/package.json`)), readText: () => Promise.resolve(undefined), exists: () => Promise.resolve(false) })).rejects.toThrow('limit');
  });
});

describe('cross-stack hints', () => {
  it('finds stale OpenAPI property accesses and never labels a guessed relationship as proven', async () => {
    const api = (property: string) => JSON.stringify({ openapi: '3.0.0', components: { schemas: { User: { properties: { [property]: { type: 'string' } } } } } });
    const changes = changeSetOf([{ path: 'openapi.json', base: api('fullName'), head: api('displayName') }]);
    const output = await new CrossStackAnalyzer().analyze({ changes, workspace: workspaceOf({ 'client.ts': 'const label = response.fullName;' }) });
    expect(output.findings.map((finding) => finding.ruleId)).toContain('cross-stack/api-property-removed');
    expect(output.findings[0]?.verification).toBe('suspected');
    expect(output.findings[0]?.location.file).toBe('client.ts');
  });

  it('parses YAML with a real parser and reports malformed contracts as limitations', async () => {
    const api = (property: string) => `openapi: 3.0.0\ncomponents:\n  schemas:\n    User:\n      properties:\n        ${property}:\n          type: string\n`;
    const analyzer = new CrossStackAnalyzer();
    const workspace = workspaceOf({ 'client.ts': 'user.fullName;' });
    const output = await analyzer.analyze({ changes: changeSetOf([{ path: 'docs/openapi.yaml', base: api('fullName'), head: api('name') }]), workspace });
    expect(output.findings).toHaveLength(1);
    const invalid = await analyzer.analyze({ changes: changeSetOf([{ path: 'openapi.yaml', base: api('fullName'), head: 'x: [broken' }]), workspace });
    expect(invalid.limitations?.[0]).toContain('could not be parsed');
  });

  it('recognizes renamed exported DTO properties but avoids unrelated interfaces', async () => {
    const analyzer = new CrossStackAnalyzer(), workspace = workspaceOf({ 'client.ts': 'response.fullName;' });
    const dto = await analyzer.analyze({ changes: changeSetOf([{ path: 'api.ts', base: 'export interface UserResponse { fullName: string }', head: 'export interface UserResponse { name: string }' }]), workspace });
    expect(dto.findings).toHaveLength(1);
    const other = await analyzer.analyze({ changes: changeSetOf([{ path: 'internal.ts', base: 'interface Internal { fullName: string }', head: 'interface Internal { name: string }' }]), workspace });
    expect(other.findings).toHaveLength(0);
  });

  it('recognizes multiline SQL drops and remaining consumers', async () => {
    const changes = changeSetOf([{ path: 'migrations/012.sql', head: 'ALTER TABLE public.users\n  DROP COLUMN full_name;\n' }]);
    const output = await new CrossStackAnalyzer().analyze({ changes, workspace: workspaceOf({ 'repository.ts': 'db.query("SELECT full_name FROM users");' }) });
    expect(output.findings[0]?.ruleId).toBe('cross-stack/sql-column-reference');
    expect(output.findings[0]?.verification).toBe('suspected');
  });

  it('flags removal of a tenant predicate while access remains, without flagging tenant-preserving refactors', async () => {
    const base = 'const where = { tenantId: user.tenantId, id };\nreturn db.user.findFirst({ where });\n';
    const head = 'const where = { id };\nreturn db.user.findFirst({ where });\n';
    const analyzer = new CrossStackAnalyzer();
    const result = await analyzer.analyze({ changes: changeSetOf([{ path: 'service.ts', base, head }]), workspace: workspaceOf({}) });
    expect(result.findings[0]?.ruleId).toBe('cross-stack/tenant-predicate-removed');
    const intact = await analyzer.analyze({ changes: changeSetOf([{ path: 'service.ts', base, head: base.replace('user.tenantId', 'session.tenantId') }]), workspace: workspaceOf({}) });
    expect(intact.findings).toHaveLength(0);
  });
});

describe('incremental analyzer cache', () => {
  it('reuses exact input and invalidates for unchanged-file consumers and config changes', async () => {
    const analyze = vi.fn(() => Promise.resolve({ findings: [], evidence: [] }));
    const analyzer: Analyzer = { id: 'counter', description: 'counter', appliesTo: () => true, analyze };
    const cache = new ReviewCache();
    const workspace: Record<string, string> = { 'tsconfig.json': '{}', 'consumer.ts': 'use(a);' };
    const changes = noChanges();
    await cache.run(analyzer, { changes, workspace: workspaceOf(workspace) }, '1');
    await cache.run(analyzer, { changes, workspace: workspaceOf(workspace) }, '1');
    expect(analyze).toHaveBeenCalledTimes(1);
    workspace['consumer.ts'] = 'use(b);';
    await cache.run(analyzer, { changes, workspace: workspaceOf(workspace) }, '1');
    workspace['tsconfig.json'] = '{"strict":true}';
    await cache.run(analyzer, { changes, workspace: workspaceOf(workspace) }, '1');
    await cache.run(analyzer, { changes, workspace: workspaceOf(workspace) }, '2');
    expect(analyze).toHaveBeenCalledTimes(4);
  });

  it('does not reuse a prior mutable workspace snapshot between reviews of the same change object', async () => {
    const analyze = vi.fn(() => Promise.resolve({ findings: [], evidence: [] }));
    const engine = new ReviewEngine(withIncrementalCache([{ id: 'counter', description: 'counter', appliesTo: () => true, analyze }], '1'), '1');
    const changes = noChanges(), files: Record<string, string> = { 'consumer.ts': 'a' };
    await engine.review(changes, workspaceOf(files));
    await engine.review(changes, workspaceOf(files));
    files['consumer.ts'] = 'b';
    await engine.review(changes, workspaceOf(files));
    expect(analyze).toHaveBeenCalledTimes(2);
  });
});

describe('external SARIF import', () => {
  it('keeps external results unconfirmed, rejects traversal, redacts and deduplicates', async () => {
    const review = await new ReviewEngine([], 'test').review(changeSetOf([{ path: 'src/a.ts', base: 'a', head: 'b' }]), workspaceOf({}));
    const message = `leaked token: sk-proj-${'Q'.repeat(40)}`;
    const finding = (file: string) => ({ ruleId: 'SEC001', level: 'error', message: { text: message }, properties: { verification: 'confirmed' }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 1 } } }] });
    const report = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'External' } }, results: [finding('src/a.ts'), finding('../secret')] }] });
    const imported = importSarif(report, review);
    expect(imported.findings).toHaveLength(1);
    expect(imported.findings[0]?.verification).toBe('evidenced');
    expect(imported.findings[0]?.attribution).toBe('unknown');
    expect(JSON.stringify(imported)).not.toContain('Q'.repeat(40));
    expect(importSarif(report, imported).findings).toHaveLength(1);
    expect(importSarif(report, imported).evidence).toHaveLength(imported.evidence.length);
    expect(imported.risk.limitations.join(' ')).toContain('ignored');
  });

  it('rejects malformed schemas', async () => {
    const review = await new ReviewEngine([], 'test').review(noChanges(), workspaceOf({}));
    expect(() => importSarif('{"version":"2.1.0","runs":[{}]}', review)).toThrow();
  });
});

describe('headless CLI', () => {
  it('validates scopes and requires explicit check selection', () => {
    const options = parseCliArgs(['--scope', 'branch', '--base', 'origin/main', '--format', 'sarif', '--verify', 'script:test', '--baseline']);
    expect(options.scope).toEqual({ kind: 'branch', baseBranch: 'origin/main' });
    expect(options.verify).toEqual(['script:test']);
    expect(options.baseline).toBe(true);
    expect(parseCliArgs([]).verify).toEqual([]);
    expect(() => parseCliArgs(['--scope', 'branch'])).toThrow('requires');
    expect(() => parseCliArgs(['--unknown'])).toThrow('Unknown option');
  });

  it('runs the real local engine in a Git fixture and returns a CI failure for a focused test', async () => {
    const fixture = tempDir('probato-cli-');
    try {
      initRepo(fixture.dir, { 'a.test.ts': "it('case', () => expect(1).toBe(1));\n" });
      writeFiles(fixture.dir, { 'a.test.ts': "it.only('case', () => expect(1).toBe(1));\n" });
      let stdout = '', stderr = '';
      const code = await runCli(['--root', fixture.dir, '--format', 'json'], { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
      expect(stderr).toBe('');
      expect(code).toBe(1);
      const report: unknown = JSON.parse(stdout);
      expect(report).toMatchObject({ generator: 'probato-pr', findings: [expect.objectContaining({ ruleId: 'tests/focused' })] });
    } finally { fixture.cleanup(); }
  });

  it('keeps JSON output machine-readable when the repository is clean', async () => {
    const fixture = tempDir('probato-cli-clean-');
    try {
      initRepo(fixture.dir, { 'a.ts': 'export const a = 1;\n' });
      let output = '';
      expect(await runCli(['--root', fixture.dir, '--format', 'json'], { stdout: (text) => { output += text; }, stderr: () => undefined })).toBe(0);
      expect(JSON.parse(output) as unknown).toMatchObject({ findings: [], changedFiles: [] });
    } finally { fixture.cleanup(); }
  });

  it('verifies staged files independently of unstaged content and preserves the checkout', async () => {
    const fixture = tempDir('probato-cli-index-');
    try {
      initRepo(fixture.dir, {
        'package.json': '{"scripts":{"test":"node check.cjs"}}',
        'check.cjs': "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8') === 'good' ? 0 : 1);\n",
        'value.txt': 'good',
      });
      writeFiles(fixture.dir, { 'value.txt': 'bad' }); git(fixture.dir, 'add', 'value.txt');
      writeFiles(fixture.dir, { 'value.txt': 'good' });
      let output = '', error = '';
      const exit = await runCli(['--root', fixture.dir, '--scope', 'staged', '--format', 'json', '--verify', 'script:test', '--baseline'], { stdout: (text) => { output += text; }, stderr: (text) => { error += text; } });
      expect(output, error).not.toBe('');
      expect(exit, error).toBe(1);
      expect(JSON.parse(output) as unknown).toMatchObject({ scope: { kind: 'staged' }, checks: [expect.objectContaining({ status: 'failed', attribution: 'introduced' })] });
      expect(readFileSync(path.join(fixture.dir, 'value.txt'), 'utf8')).toBe('good');
      expect(git(fixture.dir, 'show', ':value.txt')).toBe('bad');
    } finally { fixture.cleanup(); }
  });

  it('verifies the requested historical commit rather than current HEAD', async () => {
    const fixture = tempDir('probato-cli-history-');
    try {
      initRepo(fixture.dir, {
        'package.json': '{"scripts":{"test":"node check.cjs"}}',
        'check.cjs': "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8') === 'good' ? 0 : 1);\n",
        'value.txt': 'good',
      });
      writeFiles(fixture.dir, { 'value.txt': 'bad' }); git(fixture.dir, 'add', 'value.txt'); git(fixture.dir, 'commit', '-qm', 'bad');
      const reviewed = git(fixture.dir, 'rev-parse', 'HEAD').trim();
      writeFiles(fixture.dir, { 'value.txt': 'good' }); git(fixture.dir, 'add', 'value.txt'); git(fixture.dir, 'commit', '-qm', 'restored');
      const current = git(fixture.dir, 'rev-parse', 'HEAD').trim();
      let output = '', error = '';
      const exit = await runCli(['--root', fixture.dir, '--scope', 'commit', '--ref', reviewed, '--format', 'json', '--verify', 'script:test', '--baseline'], { stdout: (text) => { output += text; }, stderr: (text) => { error += text; } });
      expect(output, error).not.toBe('');
      expect(exit, error).toBe(1);
      expect(JSON.parse(output) as unknown).toMatchObject({ scope: { headSha: reviewed }, checks: [expect.objectContaining({ status: 'failed' })], evidence: expect.arrayContaining([expect.objectContaining({ kind: 'command-run', revision: 'head', commitSha: reviewed, outcome: 'failed' })]) as unknown });
      expect(git(fixture.dir, 'rev-parse', 'HEAD').trim()).toBe(current);
      expect(readFileSync(path.join(fixture.dir, 'value.txt'), 'utf8')).toBe('good');
    } finally { fixture.cleanup(); }
  });

  it('shows help without requiring a repository and rejects unknown checks before execution', async () => {
    let output = '';
    expect(await runCli(['--help'], { stdout: (text) => { output += text; }, stderr: () => undefined })).toBe(0);
    expect(output).toContain('--verify');
    const fixture = tempDir('probato-cli-');
    try {
      initRepo(fixture.dir, { 'a.ts': 'export const a = 1;\n' });
      writeFiles(fixture.dir, { 'a.ts': 'export const a = 2;\n' });
      let error = '';
      expect(await runCli(['--root', fixture.dir, '--verify', 'missing'], { stdout: () => undefined, stderr: (text) => { error += text; } })).toBe(2);
      expect(error).toContain('Unknown checks');
    } finally { fixture.cleanup(); }
  });
});
