import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { tr } from '../core/i18n';
import { sha256 } from '../core/ids';
import { resolveInside } from '../core/paths';

export interface DependencyProbe { readText(relative: string): Promise<string | undefined>; exists(relative: string): Promise<boolean> }
export interface DependencyComparability { readonly status: 'comparable' | 'inconclusive'; readonly reasons: readonly string[]; readonly fingerprint: string }
const INPUTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', '.npmrc', '.yarnrc.yml',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'composer.json', 'composer.lock', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock',
  'Cargo.toml', 'Cargo.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile'];
const MAX_INPUT_BYTES = 2_000_000;
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(',')}]`;
  const record = object(value);
  if (value === undefined) return 'undefined';
  return record ? `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}` : JSON.stringify(value);
}
function json(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  const record = object(parsed);
  if (!record) throw new Error(tr('Dependency metadata must contain a JSON object.'));
  return record;
}
function normalized(file: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error(tr('Dependency input {0} exceeds the safe read limit.', file));
  if (file.endsWith('package.json')) {
    const manifest = json(text);
    return canonical(Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'packageManager', 'engines', 'workspaces', 'overrides', 'resolutions', 'pnpm', 'os', 'cpu'].map((key) => [key, manifest[key]])));
  }
  return text.replace(/\r\n/g, '\n');
}
function yaml(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error(tr('Dependency metadata exceeds the safe read limit.'));
  const document = parseDocument(text, { schema: 'core', customTags: [], uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(tr('Dependency lockfile metadata is invalid YAML.'));
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}
function ancestors(cwd: string): string[] {
  if (cwd.includes('\\') || cwd.startsWith('/') || cwd.includes(':') || cwd.split('/').includes('..') || cwd.split('/').length > 16) throw new Error(tr('Invalid dependency comparison directory.'));
  const dirs: string[] = [];
  let directory = cwd.replace(/^\.\//, '').replace(/\/$/, '');
  if (directory === '.') directory = '';
  for (;;) { dirs.push(directory); if (!directory) break; directory = path.posix.dirname(directory); if (directory === '.') directory = ''; }
  return dirs;
}
function at(directory: string, file: string): string { return directory ? `${directory}/${file}` : file; }
const PREPARE_GUIDANCE = () => tr('Prepare dependencies for each revision yourself using its lockfile and an isolated checkout, then review and approve checks again. Probato PR does not install dependencies or access the network.');

/** Compares declared inputs and installed package-manager identities, never treating reused head dependencies as a base install. */
export async function compareDependencyInputs(head: DependencyProbe, base: DependencyProbe, installed: DependencyProbe, cwd: string): Promise<DependencyComparability> {
  const reasons: string[] = [];
  const inputs: [string, string | undefined, string | undefined, string | undefined][] = [];
  try {
    const dirs = ancestors(cwd);
    for (const directory of dirs) {
      for (const name of INPUTS) {
        const file = at(directory, name);
        const values = await Promise.all([head.readText(file), base.readText(file), installed.readText(file)]);
        const [h, b, i] = values.map((text) => normalized(file, text));
        inputs.push([file, h, b, i]);
        if (h !== b) reasons.push(tr('Dependency inputs differ between head and base: {0}.', file));
        if (h !== i) reasons.push(tr('Installed checkout dependency inputs differ from the reviewed revision: {0}.', file));
      }
    }
    if (!reasons.length) {
      const rootManifests = inputs.filter(([file, content]) => file.endsWith('package.json') && content !== undefined);
      for (const [file] of rootManifests) {
        const manifestText = await head.readText(file);
        if (manifestText === undefined) continue;
        const manifest = json(manifestText);
        const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => Object.keys(object(manifest[field]) ?? {}).length > 0);
        const directory = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
        // Even undeclared node_modules can affect a repository script through Node's resolution.
        const candidates = dirs.filter((dir) => directory === dir || directory.startsWith(`${dir}/`) || dir === '');
        const modulesDirectory = (await Promise.all(candidates.map(async (dir) => await installed.exists(at(dir, 'node_modules')) ? dir : undefined))).find((dir) => dir !== undefined);
        if (!declared && modulesDirectory === undefined) continue;
        if (modulesDirectory === undefined) { reasons.push(tr('Installed dependencies are missing for {0}.', file)); continue; }
        const pnpm = await head.readText(at(modulesDirectory, 'pnpm-lock.yaml'));
        const npm = await head.readText(at(modulesDirectory, 'npm-shrinkwrap.json')) ?? await head.readText(at(modulesDirectory, 'package-lock.json'));
        if (pnpm !== undefined) {
          const metadata = await installed.readText(at(modulesDirectory, 'node_modules/.pnpm/lock.yaml'));
          if (metadata === undefined || canonical(yaml(pnpm)) !== canonical(yaml(metadata))) reasons.push(tr('Installed pnpm dependency metadata does not match the reviewed lockfile for {0}.', file));
        } else if (npm !== undefined) {
          const metadata = await installed.readText(at(modulesDirectory, 'node_modules/.package-lock.json'));
          const wanted = object(json(npm)['packages']);
          const present = metadata === undefined ? undefined : object(json(metadata)['packages']);
          if (!wanted || !present) { reasons.push(tr('Installed npm dependency metadata is unavailable for {0}.', file)); continue; }
          const packageKeys = Object.keys(present);
          if (packageKeys.length > 2000) throw new Error(tr('Installed dependency comparison exceeds the safe package limit.'));
          let mismatch = !packageKeys.length && declared;
          for (const packageKey of packageKeys) {
            const expected = object(wanted[packageKey]);
            const actual = object(present[packageKey]);
            if (!expected || !actual || actual['link'] === true || expected['link'] === true || canonical(['version', 'resolved', 'integrity'].map((key) => actual[key])) !== canonical(['version', 'resolved', 'integrity'].map((key) => expected[key]))) { mismatch = true; break; }
            const packageManifest = await installed.readText(at(modulesDirectory, `${packageKey}/package.json`));
            if (!packageManifest || json(packageManifest)['version'] !== expected['version']) { mismatch = true; break; }
          }
          for (const [packageKey, value] of Object.entries(wanted)) {
            const entry = object(value);
            if (packageKey && entry && entry['optional'] !== true && !Object.hasOwn(present, packageKey)) mismatch = true;
          }
          // Required direct dependencies must be present; optional platform packages can be absent.
          for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            for (const dependency of Object.keys(object(manifest[field]) ?? {})) {
              if (!Object.hasOwn(present, `node_modules/${dependency}`)) mismatch = true;
            }
          }
          if (mismatch) reasons.push(tr('Installed npm package identities do not match the reviewed lockfile for {0}.', file));
        } else reasons.push(tr('Installed dependencies cannot be matched to a supported lockfile for {0}.', file));
      }
      // Other ecosystems need revision-specific environment evidence; input equality alone is insufficient.
      const externalEnvironment = inputs.find(([file, content]) => content !== undefined && (/(?:^|\/)(?:composer\.json|requirements\.txt|Pipfile|pyproject\.toml|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?)$/.test(file) || /(?:^|\/)go\.mod$/.test(file) && /\brequire\b/.test(content)));
      if (externalEnvironment) reasons.push(tr('The installed environment for {0} cannot be matched to the base revision without a separate prepared environment.', externalEnvironment[0]));
    }
  } catch (error) {
    reasons.push(tr('Dependency comparability could not be established: {0}', error instanceof Error ? error.message : String(error)));
  }
  const fingerprint = sha256(JSON.stringify(inputs));
  return reasons.length ? { status: 'inconclusive', reasons: [...new Set(reasons), PREPARE_GUIDANCE()], fingerprint } : { status: 'comparable', reasons: [tr('Dependency inputs and available installed package metadata match both revisions. This does not attest to toolchain or external service equivalence.')], fingerprint };
}

/** Bounded read-only adapter. Missing files differ from unreadable, oversized, or escaping inputs. */
export function dependencyProbe(root: string): DependencyProbe {
  const reads = new Map<string, Promise<string | undefined>>();
  let totalBytes = 0;
  return {
    readText(relative) {
      let pending = reads.get(relative);
      if (!pending) {
        if (reads.size >= 2048) throw new Error(tr('Installed dependency comparison exceeds the safe package limit.'));
        pending = (async () => {
          let file;
          try {
            file = await open(await resolveInside(root, relative), 'r');
            const info = await file.stat();
            if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error(tr('Dependency input {0} exceeds the safe read limit.', relative));
            const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_INPUT_BYTES) throw new Error(tr('Dependency input {0} exceeds the safe read limit.', relative));
            totalBytes += bytesRead;
            if (totalBytes > 16_000_000) throw new Error(tr('Dependency comparison exceeds the total safe read limit.'));
            return buffer.subarray(0, bytesRead).toString('utf8');
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
          finally { await file?.close(); }
        })();
        reads.set(relative, pending);
      }
      return pending;
    },
    async exists(relative) { try { return (await stat(await resolveInside(root, relative))).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } },
  };
}
