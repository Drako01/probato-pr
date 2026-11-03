import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceIndex } from '../core/analyzer';
import { tr } from '../core/i18n';
import { sha256 } from '../core/ids';
import type { PlannedCheck } from '../core/model';
import { resolveInside } from '../core/paths';
import { GitClient } from '../git/git-client';
import { NodeProcessRunner } from '../infrastructure/process-runner';
import { GitWorkspaceIndex } from '../infrastructure/workspace-index';
import { detectChecks, type ProjectProbe } from './check-detector';
import { executionDefinition } from './execution-definition';

const MANIFEST = /(?:^|\/)(?:package\.json|go\.mod|composer\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Pipfile|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?)$/;
const GENERATED = /(?:^|\/)(?:node_modules|vendor|\.venv|venv|env|target|dist|build|\.git)\//;
const MAX_PROJECTS = 200;

export interface ProjectTree extends ProjectProbe {
  listFiles(): Promise<readonly string[]>;
}

/** Discovers project roots from Git-visible manifests, including polyglot and nested workspaces. */
export async function detectProjectChecks(tree: ProjectTree, platform: NodeJS.Platform = process.platform, snapshot?: string): Promise<PlannedCheck[]> {
  const files = await tree.listFiles();
  const roots = [...new Set(['', ...files.filter((f) => MANIFEST.test(f) && !GENERATED.test(f)).map((f) => path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f))])].sort();
  if (roots.length > MAX_PROJECTS) {
    throw new Error(tr('Verification discovery found {0} projects; the limit is {1}. Open a smaller repository.', roots.length, MAX_PROJECTS));
  }
  const rootDefinition = sha256(JSON.stringify([await executionDefinition(tree), (await tree.readText('package.json'))?.replace(/\r\n/g, '\n'), await tree.readText('.probato.yml')]));
  const checks: PlannedCheck[] = [];
  for (const cwd of roots) {
    const at = (relative: string) => cwd ? `${cwd}/${relative}` : relative;
    const hasOwnLock = cwd && (await Promise.all(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].map((lock) => tree.exists(at(lock))))).some(Boolean);
    const plan = await detectChecks({
      readText: (f) => tree.readText(at(f)),
      exists: async (f) => (await tree.exists(at(f))) || Boolean(cwd && !hasOwnLock && ['pnpm-lock.yaml', 'yarn.lock'].includes(f) && await tree.exists(f)),
    }, platform);
    for (const check of plan) {
      checks.push({
        ...check,
        id: cwd ? `${cwd}:${check.id}` : check.id,
        cwd: cwd ? path.posix.join(cwd, check.cwd) : check.cwd,
        label: cwd ? `${cwd}: ${check.label}` : check.label,
        fingerprint: sha256(JSON.stringify([check.fingerprint, cwd, rootDefinition, snapshot ?? 'unbound'])),
      });
    }
  }
  return checks;
}

/** Filesystem adapter keeps every manifest/tool probe inside the repository, including symlinks. */
export async function detectMonorepoChecks(root: string, platform: NodeJS.Platform = process.platform, snapshot?: string, workspace?: WorkspaceIndex, dependencyRoot?: string): Promise<PlannedCheck[]> {
  const git = new GitClient(new NodeProcessRunner(), { timeoutMs: 60_000, maxBytes: 64_000_000 });
  const index = workspace ?? new GitWorkspaceIndex(git, root, 2_000_000);
  return detectProjectChecks({
    listFiles: () => index.listFiles(() => true),
    readText: async (relative) => {
      try { return await readFile(await resolveInside(root, relative), 'utf8'); } catch { return undefined; }
    },
    exists: async (relative) => {
      try { await access(await resolveInside(root, relative)); return true; } catch {
        // A reviewed worktree deliberately links approved Node tools from the original checkout.
        // Only presence probes use this root; executable project files are always read from root.
        if (dependencyRoot && /(?:^|\/)node_modules(?:\/|$)/.test(relative)) {
          try { await access(await resolveInside(dependencyRoot, relative)); return true; } catch { return false; }
        }
        return false;
      }
    },
  }, platform, snapshot);
}
