import * as ts from 'typescript';
import type { AnalyzerContext } from '../core/analyzer';
import { tr } from '../core/i18n';
import { firstExistingModule, isScriptFile, joinRepoPath, parsePathAliases, resolveImport, type PathAliases } from './ts-ast';

const MAX_FILES = 5000;
const MAX_CHARS = 16_000_000;
const MAX_CONFIG_DEPTH = 16;
export interface SymbolOrigin { readonly module: string; readonly name: string }

/** Snapshot-only compiler hosts: no TS system host, ambient libraries, plugins, emit, or filesystem fallback. */
export class SemanticContracts {
  private constructor(
    private readonly before: ts.Program,
    private readonly after: ts.Program,
    private readonly beforeResolve: (from: string, specifier: string) => string | undefined,
    private readonly afterResolve: (from: string, specifier: string) => string | undefined,
    readonly sources: ReadonlyMap<string, string>,
    readonly limitations: readonly string[],
  ) {}

  static async create(context: AnalyzerContext): Promise<{ graph?: SemanticContracts; limitations: readonly string[] }> {
    const files = await context.workspace.listFiles((file) => isScriptFile(file) || /\.json$/.test(file));
    if (files.length > MAX_FILES) return { limitations: [tr('Semantic contract analysis limited to {0} files; conservative import analysis was used instead.', MAX_FILES)] };
    const head = new Map<string, string>();
    let chars = 0;
    const changed = new Map(context.changes.files.map((file) => [file.path, file]));
    for (const file of [...new Set([...files, ...changed.keys()])]) {
      if (context.signal?.aborted) return { limitations: [tr('Semantic contract analysis was cancelled.')] };
      const text = changed.has(file) ? await context.changes.content.read(file, 'head') : await context.workspace.read(file);
      if (text === undefined) {
        if (isScriptFile(file) && changed.get(file)?.status !== 'deleted') return { limitations: [tr('Some source files were unavailable in the reviewed snapshot; conservative import analysis was used instead.')] };
        continue;
      }
      chars += text.length;
      if (chars > MAX_CHARS) return { limitations: [tr('Semantic contract analysis exceeded its content budget; conservative import analysis was used instead.')] };
      head.set(file, text);
    }
    const base = new Map(head);
    for (const file of context.changes.files) {
      const text = await context.changes.content.read(file.path, 'base');
      chars += text?.length ?? 0;
      if (chars > MAX_CHARS) return { limitations: [tr('Semantic contract analysis exceeded its content budget; conservative import analysis was used instead.')] };
      if (file.oldPath) base.delete(file.path);
      const beforePath = file.oldPath ?? file.path;
      if (text === undefined) base.delete(beforePath); else base.set(beforePath, text);
    }
    const limitations: string[] = [];
    const beforeResolve = resolver(base, limitations);
    const afterResolve = resolver(head, limitations);
    return { graph: new SemanticContracts(program(base, beforeResolve), program(head, afterResolve), beforeResolve, afterResolve, head, limitations), limitations: [...new Set(limitations)] };
  }

  references(importer: string, position: number, expected: SymbolOrigin): boolean {
    // Call locations belong to the head snapshot; using the base here misattributes moved or shadowed calls.
    const source = this.after.getSourceFile('/' + importer);
    if (!source) return false;
    let located: ts.Node | undefined;
    const find = (node: ts.Node): void => {
      if (located || position < node.getFullStart() || position >= node.end) return;
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && node.getStart(source) === position) { located = node; return; }
      ts.forEachChild(node, find);
    };
    find(source);
    if (!located) return false;
    const checker = this.after.getTypeChecker();
    const symbol = checker.getSymbolAtLocation(located);
    const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    const declaration = resolved?.declarations?.[0];
    return Boolean(declaration && declaration.getSourceFile().fileName === '/' + expected.module && resolved.name === expected.name);
  }

  /** Resolve through the base graph; reject a dependency replaced by a different head export. */
  origin(importer: string, specifier: string, exported: string): SymbolOrigin | undefined {
    const before = originOf(this.before, this.beforeResolve(importer, specifier), exported);
    if (!before) return undefined;
    const after = originOf(this.after, this.afterResolve(importer, specifier), exported);
    if (after && (after.module !== before.module || after.name !== before.name)) return undefined;
    return before;
  }
}

function originOf(program: ts.Program, module: string | undefined, exported: string): SymbolOrigin | undefined {
  if (!module) return undefined;
  const source = program.getSourceFile('/' + module);
  if (!source) return undefined;
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const symbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === exported);
  if (!symbol) return undefined;
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = target.declarations?.[0];
  if (!declaration) return undefined;
  return { module: declaration.getSourceFile().fileName.replace(/^\//, ''), name: target.name };
}

function program(texts: ReadonlyMap<string, string>, resolve: (from: string, specifier: string) => string | undefined): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] };
  const host: ts.CompilerHost = {
    getSourceFile: (file, languageVersion) => { const text = texts.get(file.replace(/^\//, '')); return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true); },
    getDefaultLibFileName: () => '/__probato_no_lib__.d.ts', writeFile: () => undefined,
    getCurrentDirectory: () => '/', getDirectories: () => [], useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (file) => file, getNewLine: () => '\n',
    fileExists: (file) => texts.has(file.replace(/^\//, '')), readFile: (file) => texts.get(file.replace(/^\//, '')),
    resolveModuleNameLiterals: (literals, containing) => literals.map((literal) => {
      const file = resolve(containing.replace(/^\//, ''), literal.text);
      return { resolvedModule: file ? { resolvedFileName: '/' + file, extension: extensionOf(file), isExternalLibraryImport: false } : undefined };
    }),
  };
  return ts.createProgram([...texts.keys()].filter(isScriptFile).map((file) => '/' + file), options, host);
}

function resolver(texts: ReadonlyMap<string, string>, limitations: string[]): (from: string, specifier: string) => string | undefined {
  const existing = new Set([...texts.keys()].filter(isScriptFile));
  const configs = [...texts.keys()].filter((file) => /(?:^|\/)tsconfig\.json$/.test(file)).sort((a, b) => b.length - a.length);
  const cache = new Map<string, PathAliases | undefined>();
  function aliases(file: string, seen = new Set<string>()): PathAliases | undefined {
    if (cache.has(file)) return cache.get(file);
    if (seen.size >= MAX_CONFIG_DEPTH || seen.has(file)) { limitations.push(tr('A TypeScript configuration inheritance cycle or depth limit prevented complete alias resolution.')); return undefined; }
    seen.add(file);
    const text = texts.get(file);
    if (!text) return undefined;
    const parsed = ts.parseConfigFileTextToJson(file, text) as { config?: { extends?: unknown; compilerOptions?: unknown }; error?: unknown };
    if (parsed.error) { limitations.push(tr('A TypeScript configuration could not be parsed; some aliases may be unresolved.')); return undefined; }
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    let inherited: PathAliases | undefined;
    const parents = Array.isArray(parsed.config?.extends) ? parsed.config.extends : [parsed.config?.extends];
    for (const parent of parents) {
      if (typeof parent !== 'string') continue;
      if (!parent.startsWith('.')) { limitations.push(tr('Package-based TypeScript configuration inheritance is not loaded by snapshot-only semantic analysis.')); continue; }
      const candidate = joinRepoPath(dir, parent);
      const target = candidate && (texts.has(candidate) ? candidate : candidate + '.json');
      if (!target || !texts.has(target)) { limitations.push(tr('An inherited TypeScript configuration is outside the available snapshot.')); continue; }
      inherited = aliases(target, new Set(seen)) ?? inherited;
    }
    const result = parsePathAliases(text, dir) ?? inherited;
    cache.set(file, result); return result;
  }
  const packages = new Map<string, { directory: string; manifest: Record<string, unknown> }>();
  const ambiguousPackages = new Set<string>();
  for (const [file, text] of texts) {
    if (!/(?:^|\/)package\.json$/.test(file)) continue;
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      if (typeof manifest.name === 'string' && !ambiguousPackages.has(manifest.name)) {
        if (packages.has(manifest.name)) { packages.delete(manifest.name); ambiguousPackages.add(manifest.name); limitations.push(tr('Workspace package names are ambiguous; no dependency relationship was inferred for {0}.', manifest.name)); }
        else packages.set(manifest.name, { directory: file.slice(0, -'package.json'.length), manifest });
      }
    } catch { /* Invalid manifests are not executable and do not establish a module relationship. */ }
  }
  return (from, specifier) => {
    const config = configs.find((file) => { const dir = file.slice(0, -'tsconfig.json'.length); return from.startsWith(dir); });
    const direct = resolveImport(from, specifier, existing, config ? aliases(config) : undefined);
    if (direct) return direct;
    for (const [name, pkg] of packages) {
      if (specifier !== name && !specifier.startsWith(name + '/')) continue;
      const subpath = specifier.slice(name.length).replace(/^\//, '');
      const exports = pkg.manifest.exports;
      const entry = typeof exports === 'object' && exports !== null && !Array.isArray(exports) ? (exports as Record<string, unknown>)[subpath ? './' + subpath : '.'] ?? (subpath ? undefined : exports) : subpath ? undefined : exports;
      const exported = exportTarget(entry);
      if (exports !== undefined && exported === undefined) { limitations.push(tr('A workspace package export condition or subpath could not be resolved; no dependency relationship was inferred.')); return undefined; }
      const candidate = exported ?? (subpath || ['source', 'types', 'module', 'main'].map((key) => pkg.manifest[key]).find((value): value is string => typeof value === 'string') || 'index');
      const target = joinRepoPath(pkg.directory, candidate);
      return target === undefined ? undefined : firstExistingModule(target, existing);
    }
    return undefined;
  };
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    for (const key of ['types', 'source', 'import', 'default']) { const target = exportTarget(entry[key]); if (target) return target; }
  }
  return undefined;
}

function extensionOf(file: string): ts.Extension {
  if (file.endsWith('.d.ts')) return ts.Extension.Dts;
  if (file.endsWith('.d.mts')) return ts.Extension.Dmts;
  if (file.endsWith('.d.cts')) return ts.Extension.Dcts;
  const extensions: Readonly<Record<string, ts.Extension>> = { ts: ts.Extension.Ts, tsx: ts.Extension.Tsx, mts: ts.Extension.Mts, cts: ts.Extension.Cts, js: ts.Extension.Js, jsx: ts.Extension.Jsx, mjs: ts.Extension.Mjs, cjs: ts.Extension.Cjs };
  return extensions[file.split('.').at(-1) ?? 'ts'] ?? ts.Extension.Ts;
}
