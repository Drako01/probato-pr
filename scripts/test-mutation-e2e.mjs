// Explicit opt-in only. Stryker is never installed into the Probato repository or normal user projects.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

if (process.env.PROBATO_MUTATION_E2E !== '1') {
  console.error('Set PROBATO_MUTATION_E2E=1 to authorize the real Stryker fixture. Supply PROBATO_MUTATION_FIXTURE_ROOT with an installed temporary fixture, or explicitly set PROBATO_MUTATION_E2E_INSTALL=1 to install only into a new temporary fixture.');
  process.exitCode = 2;
} else {
  const existing = process.env.PROBATO_MUTATION_FIXTURE_ROOT;
  if (!existing && process.env.PROBATO_MUTATION_E2E_INSTALL !== '1') throw new Error('A prepared temporary fixture or explicit temporary installation approval is required.');
  const root = existing ? path.resolve(existing) : await mkdtemp(path.join(tmpdir(), 'probato-stryker-e2e-'));
  const relative = path.relative(tmpdir(), root);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('probato-stryker-e2e-')) throw new Error('The mutation E2E runner only accepts its isolated temporary fixture directories.');
  if (!existing) await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'probato-mutation-fixture', version: '1.0.0', private: true, type: 'module', devDependencies: { '@stryker-mutator/core': '10.1.1' } }));
  else JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const bundle = path.join(root, 'probato-e2e-runner.cjs');
  await build({ entryPoints: ['test/fixtures/mutation/run-e2e.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
  const child = spawn(process.execPath, [bundle], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PROBATO_MUTATION_FIXTURE_ROOT: root } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (status) => { resolve(status ?? 1); }); });
  process.exitCode = code;
}
