import * as ts from 'typescript';
import type { FileChange } from '../core/model';

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

export const SOURCE_EXTENSIONS = Object.keys(SCRIPT_KINDS);

function extensionOf(path: string): string {
  const match = /\.[^./]+$/.exec(path);
  return match ? match[0].toLowerCase() : '';
}

export function isScriptFile(path: string): boolean {
  return extensionOf(path) in SCRIPT_KINDS;
}

export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:__tests__|__specs__)\//.test(path) || /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i.test(path);
}

export function isAnalyzableScript(file: FileChange): boolean {
  return !file.binary && isScriptFile(file.path);
}

export function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extensionOf(path)] ?? ts.ScriptKind.TS);
}

/** 1-based line of a node's first token. */
export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function endLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

export function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => {
    visit(child, callback);
  });
}

export function lineText(sourceFile: ts.SourceFile, line: number): string {
  return sourceFile.text.split('\n')[line - 1]?.trim() ?? '';
}

/** Name of a callee: `it`, `it.skip`, `describe.only.each` → ['describe','only','each']. */
export function calleePath(expression: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const left = calleePath(expression.expression);
    return left ? [...left, expression.name.text] : undefined;
  }
  if (ts.isCallExpression(expression)) {
    // describe.each([...])('name', fn)
    return calleePath(expression.expression);
  }
  return undefined;
}

export function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  if (node && ts.isTemplateExpression(node)) {
    return node.getText();
  }
  return undefined;
}

/**
 * Resolves a relative module specifier from an importer to candidate repository paths
 * (extension inference, index files, and the TS ESM convention of importing "./x.js" for "./x.ts").
 */
export function resolveRelativeImport(importer: string, specifier: string, existing: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const baseDir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '';
  const target = joinRepoPath(baseDir, specifier);
  return target === undefined ? undefined : firstExistingModule(target, existing);
}

/** Joins and normalizes repository-relative POSIX segments; undefined when ".." escapes the repository. */
function joinRepoPath(...segments: string[]): string | undefined {
  const normalized: string[] = [];
  for (const part of segments.join('/').split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalized.length === 0) {
        return undefined;
      }
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join('/');
}

/** Applies TypeScript's module lookup (extensions, index files, ".js" → ".ts") to a repository path. */
function firstExistingModule(target: string, existing: ReadonlySet<string>): string | undefined {
  const withoutJsExt = target.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [
    target,
    ...SOURCE_EXTENSIONS.map((ext) => `${withoutJsExt}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  return candidates.find((candidate) => existing.has(candidate));
}

export interface PathAliases {
  readonly baseDir: string;
  readonly entries: readonly { readonly pattern: string; readonly targets: readonly string[] }[];
}

/**
 * Reads `compilerOptions.baseUrl` / `paths` from a tsconfig (JSONC). `extends` chains are not followed.
 * Returns undefined when the config declares no path aliases.
 */
export function parsePathAliases(tsconfigText: string, tsconfigDir = ''): PathAliases | undefined {
  const { config } = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText) as { config?: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } };
  const options = config?.compilerOptions;
  if (typeof options?.paths !== 'object' || options.paths === null) {
    return undefined;
  }
  const baseDir = joinRepoPath(tsconfigDir, typeof options.baseUrl === 'string' ? options.baseUrl : '.');
  if (baseDir === undefined) {
    return undefined;
  }
  const entries = Object.entries(options.paths as Record<string, unknown>)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((t) => typeof t === 'string'))
    .map(([pattern, targets]) => ({ pattern, targets }));
  return entries.length > 0 ? { baseDir, entries } : undefined;
}

/** Resolves relative specifiers and, when aliases are known, tsconfig `paths` aliases such as "@/api/user". */
export function resolveImport(importer: string, specifier: string, existing: ReadonlySet<string>, aliases?: PathAliases): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveRelativeImport(importer, specifier, existing);
  }
  for (const { pattern, targets } of aliases?.entries ?? []) {
    const star = pattern.indexOf('*');
    let captured: string | undefined;
    if (star === -1) {
      captured = specifier === pattern ? '' : undefined;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      const matches = specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
      captured = matches ? specifier.slice(prefix.length, specifier.length - suffix.length) : undefined;
    }
    if (captured === undefined || !aliases) {
      continue;
    }
    for (const target of targets) {
      const joined = joinRepoPath(aliases.baseDir, target.replace('*', captured));
      const found = joined === undefined ? undefined : firstExistingModule(joined, existing);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export interface ImportBinding {
  /** Name exported by the target module ('default' or '*' for namespace imports). */
  readonly imported: string;
  readonly local: string;
  readonly line: number;
}

export interface ModuleImport {
  readonly specifier: string;
  readonly line: number;
  readonly bindings: readonly ImportBinding[];
}

/** Static imports, re-exports and literal require() calls of a source file. */
export function collectImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings: ImportBinding[] = [];
      const clause = statement.importClause;
      const line = lineOf(sourceFile, statement);
      if (clause?.name) {
        bindings.push({ imported: 'default', local: clause.name.text, line });
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.push({ imported: '*', local: named.name.text, line });
      } else if (named) {
        for (const element of named.elements) {
          bindings.push({
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
            line: lineOf(sourceFile, element),
          });
        }
      }
      imports.push({ specifier: statement.moduleSpecifier.text, line, bindings });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const line = lineOf(sourceFile, statement);
      const bindings: ImportBinding[] =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map((e) => ({
              imported: (e.propertyName ?? e.name).text,
              local: e.name.text,
              line: lineOf(sourceFile, e),
            }))
          : [{ imported: '*', local: '*', line }];
      imports.push({ specifier: statement.moduleSpecifier.text, line, bindings });
    }
  }
  visit(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const line = lineOf(sourceFile, node);
      const parent = node.parent;
      const bindings: ImportBinding[] = [];
      if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          if (ts.isIdentifier(element.name)) {
            const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            bindings.push({ imported, local: element.name.text, line });
          }
        }
      } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        bindings.push({ imported: '*', local: parent.name.text, line });
      }
      imports.push({ specifier: node.arguments[0].text, line, bindings });
    }
  });
  return imports;
}
