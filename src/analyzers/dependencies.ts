import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import type { ChangeSet, FileChange } from '../core/model';
import { addedLines } from '../git/diff-parser';
import { collectImports, isScriptFile, parseSource } from './ts-ast';

const ID = 'dependencies';
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'] as const;
const MAX_IMPORT_SCAN = 25_000;

interface PackageJson {
  readonly scripts?: Record<string, unknown>;
  readonly [section: string]: unknown;
}

function parsePackageJson(text: string | undefined): PackageJson | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as PackageJson) : undefined;
  } catch {
    return undefined; // malformed JSON is reported by the project's own tooling
  }
}

function depsOf(pkg: PackageJson | undefined): Map<string, string> {
  const deps = new Map<string, string>();
  for (const section of SECTIONS) {
    const entries = pkg?.[section];
    if (typeof entries === 'object' && entries !== null) {
      for (const [name, range] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof range === 'string') {
          deps.set(name, range);
        }
      }
    }
  }
  return deps;
}

/** Leading major version of a semver range ("^4.2.0" → 4); undefined for tags, URLs and workspaces. */
export function majorOf(range: string): number | undefined {
  const match = /^[\^~>=v\s]*(\d+)(?:\.|$)/.exec(range.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function lineOfKey(text: string, key: string): number {
  const index = text.split('\n').findIndex((l) => l.includes(`"${key}"`));
  return index === -1 ? 1 : index + 1;
}

function importedPackage(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Dependency manifest changes: install-time scripts, major upgrades, removed packages still imported, go.mod replaces. */
export class DependenciesAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Risky dependency and package manifest changes';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => f.path.endsWith('package.json') || f.path.endsWith('go.mod'));
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    for (const file of context.changes.files) {
      if (file.status === 'deleted') {
        continue;
      }
      if (file.path === 'package.json' || file.path.endsWith('/package.json')) {
        await this.analyzePackageJson(file, context, out);
      } else if (file.path === 'go.mod' || file.path.endsWith('/go.mod')) {
        this.analyzeGoMod(file, out);
      }
    }
    return out;
  }

  private async analyzePackageJson(file: FileChange, { changes, workspace }: AnalyzerContext, out: OutputCollector): Promise<void> {
    const [baseText, headText] = await Promise.all([changes.content.read(file.path, 'base'), changes.content.read(file.path, 'head')]);
    const base = parsePackageJson(baseText);
    const head = parsePackageJson(headText);
    if (!head || headText === undefined) {
      return;
    }

    for (const script of INSTALL_SCRIPTS) {
      const after = head.scripts?.[script];
      const before = base?.scripts?.[script];
      if (typeof after === 'string' && after !== before) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'dependencies/install-script',
            severity: 'high',
            verification: 'evidenced',
            verificationNote: `The "${script}" script ${before === undefined ? 'was added' : 'changed'} in ${file.path}.`,
            title: `Install-time script ${before === undefined ? 'added' : 'changed'}: "${script}"`,
            description: `"${script}" runs automatically on install for every developer and CI job. New or changed install hooks are a common supply-chain attack vector and must be reviewed line by line.`,
            location: { file: file.path, startLine: lineOfKey(headText, script) },
            evidenceDescription: `${script}: ${after.slice(0, 200)}`,
            excerpt: after.slice(0, 200),
          }),
        );
      }
    }

    const baseDeps = depsOf(base);
    const headDeps = depsOf(head);
    for (const [name, after] of headDeps) {
      const before = baseDeps.get(name);
      const majorBefore = before === undefined ? undefined : majorOf(before);
      const majorAfter = majorOf(after);
      if (majorBefore !== undefined && majorAfter !== undefined && majorAfter > majorBefore) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'dependencies/major-upgrade',
            severity: 'medium',
            verification: 'suspected',
            verificationNote: `Version range moved from "${before ?? ''}" to "${after}". Breaking changes are likely but were not verified; run the type-check and tests.`,
            title: `Major upgrade of ${name} (${String(majorBefore)} → ${String(majorAfter)})`,
            description: 'Major versions may remove or change APIs. Review the package changelog and run the project checks.',
            location: { file: file.path, startLine: lineOfKey(headText, name) },
            evidenceDescription: `${name}: "${before ?? ''}" → "${after}"`,
          }),
        );
      }
    }

    const removed = [...baseDeps.keys()].filter((name) => !headDeps.has(name));
    if (removed.length === 0) {
      return;
    }
    const removedSet = new Set(removed);
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
    const allSources = await workspace.listFiles((p) => isScriptFile(p) && p.startsWith(dir));
    const sources = allSources.slice(0, MAX_IMPORT_SCAN);
    if (allSources.length > sources.length) {
      out.limitations.push(`Import scan for removed dependencies limited to ${MAX_IMPORT_SCAN} of ${allSources.length} source files.`);
    }
    const reported = new Set<string>();
    for (const source of sources) {
      const text = await workspace.read(source);
      if (text === undefined || !removed.some((name) => text.includes(name))) {
        continue;
      }
      for (const imp of collectImports(parseSource(source, text))) {
        const pkg = importedPackage(imp.specifier);
        if (pkg && removedSet.has(pkg) && !reported.has(pkg)) {
          reported.add(pkg);
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: 'dependencies/removed-but-imported',
              severity: 'high',
              verification: 'evidenced',
              verificationNote: `"${pkg}" was removed from ${file.path} and is still imported by ${source}:${imp.line}.`,
              title: `Removed dependency ${pkg} is still imported`,
              description: `${source} imports "${imp.specifier}", but ${pkg} is no longer declared. Installs from a clean lockfile will fail at runtime or build time.`,
              location: { file: source, startLine: imp.line },
              evidenceDescription: `${pkg} removed from ${file.path}; imported at ${source}:${imp.line}.`,
              evidenceLocations: [
                { file: source, startLine: imp.line },
                { file: file.path, startLine: 1 },
              ],
            }),
          );
        }
      }
    }
  }

  private analyzeGoMod(file: FileChange, out: OutputCollector): void {
    for (const { line, text } of addedLines(file)) {
      const replace = /^\s*(?:replace\s+)?(\S+)(?:\s+\S+)?\s+=>\s+(\.{1,2}\/\S*|\/\S+)/.exec(text);
      if (replace?.[1] && replace[2]) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'dependencies/go-local-replace',
            severity: 'medium',
            verification: 'evidenced',
            verificationNote: 'An added go.mod line replaces a module with a local filesystem path.',
            title: `Local replace directive for ${replace[1]}`,
            description: 'Builds on other machines and in CI will fail or use different code unless the same local path exists.',
            location: { file: file.path, startLine: line },
            evidenceDescription: `Added line ${line}: ${text.trim()}`,
            excerpt: text.trim(),
          }),
        );
      }
    }
  }
}
