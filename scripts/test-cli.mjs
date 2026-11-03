import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const cli = path.resolve('dist/cli.cjs');
const root = mkdtempSync(path.join(tmpdir(), 'probato-cli-smoke-'));
const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: 'pipe' });
const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', maxBuffer: 10_000_000 });
try {
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'export const value = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  writeFileSync(path.join(root, 'src/a.ts'), `export const value = 1;\nexport const token = '${'ghp_' + 'Q'.repeat(40)}';\n`);
  const json = run('--format', 'json');
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.findings.some((f) => f.ruleId === 'secrets/github-token'));
  assert.ok(!json.stdout.includes('ghp_' + 'Q'.repeat(40)));
  const sarif = run('--format', 'sarif', '--fail-on', 'none');
  assert.equal(sarif.status, 0, sarif.stderr);
  assert.equal(JSON.parse(sarif.stdout).version, '2.1.0');
  assert.equal(run('--unknown').status, 2);
  const checks = run('--list-checks');
  assert.equal(checks.status, 0, checks.stderr);
  assert.deepEqual(JSON.parse(checks.stdout), []);
  console.log('CLI smoke: JSON, SARIF, redaction, thresholds, validation and check listing passed.');
} finally { rmSync(root, { recursive: true, force: true }); }
