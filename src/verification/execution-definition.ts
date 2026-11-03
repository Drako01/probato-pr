import { sha256 } from '../core/ids';
import type { ProjectProbe } from './ecosystems/shared';

const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc.json', '.eslintrc.js', '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  'package-lock.json', 'yarn.lock', 'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js',
  'vite.config.ts', 'jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'composer.json', 'composer.lock', 'phpunit.xml', 'phpunit.xml.dist',
  'phpstan.neon', 'phpstan.neon.dist', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'conftest.py',
  'mypy.ini', 'ruff.toml', '.ruff.toml', 'Cargo.toml', 'Cargo.lock', 'build.rs', '.cargo/config.toml',
  'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gradle.properties', '.mvn/extensions.xml', '.mvn/maven.config', '.mvn/wrapper/maven-wrapper.properties',
  'gradle/wrapper/gradle-wrapper.properties'];

/** Config and local script dependencies are hashed, never persisted as approval text. Full repository
 * snapshots at the execution boundary additionally cover dynamic imports and generated commands. */
export async function executionDefinition(probe: ProjectProbe, seeds: readonly string[] = CONFIG_FILES): Promise<string> {
  const queue = [...seeds];
  const seen = new Set<string>();
  const contents: [string, string | undefined][] = [];
  while (queue.length > 0 && seen.size < 256) {
    const file = queue.shift();
    if (!file || seen.has(file) || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) {
      continue;
    }
    seen.add(file);
    const text = await probe.readText(file);
    contents.push([file, text?.replace(/\r\n/g, '\n')]);
    if (text === undefined || text.length > 1_000_000) {
      continue;
    }
    // Relative imports in executable configuration are part of the definition too.
    for (const match of text.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"\s]+)['"]/g)) {
      const spec = match[1];
      if (!spec) continue;
      const prefix = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const relative = `${prefix}${spec.replace(/^\.\//, '')}`;
      queue.push(relative, `${relative}.js`, `${relative}.cjs`, `${relative}.mjs`, `${relative}.ts`);
    }
  }
  return sha256(JSON.stringify(contents.sort(([a], [b]) => a.localeCompare(b))));
}

/** A package manager also executes lifecycle hooks and delegated scripts. */
export async function nodeScriptDefinition(probe: ProjectProbe, scripts: Readonly<Record<string, unknown>>, selected: string): Promise<string> {
  const queue = [selected];
  const seen = new Set<string>();
  const bodies: [string, unknown][] = [];
  const files: string[] = [];
  while (queue.length > 0 && seen.size < 256) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    for (const script of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[script];
      bodies.push([script, body]);
      if (typeof body !== 'string') continue;
      for (const match of body.matchAll(/(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
        const child = match[1];
        if (child && scripts[child] !== undefined) queue.push(child);
      }
      for (const match of body.matchAll(/(?:^|[\s;&|])(?:node|bun|tsx|ts-node|python3?|sh|bash)\s+([\w./-]+\.(?:[cm]?js|tsx?|py|sh))(?=$|[\s"'])/g)) {
        if (match[1]) files.push(match[1]);
      }
    }
  }
  return sha256(JSON.stringify([bodies.sort(([a], [b]) => a.localeCompare(b)), await executionDefinition(probe, files)]));
}
