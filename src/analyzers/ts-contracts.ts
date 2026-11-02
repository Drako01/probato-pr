import * as ts from 'typescript';
import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import type { ChangeSet, FileChange } from '../core/model';
import { collectImports, isScriptFile, isTestFile, lineOf, parsePathAliases, parseSource, resolveImport, visit } from './ts-ast';

const ID = 'ts-contracts';
const MAX_IMPORTER_SCAN = 25_000;

interface ExportedSymbol {
  readonly name: string;
  readonly kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'reexport';
  readonly line: number;
  readonly requiredParams?: number;
  readonly members?: ReadonlyMap<string, number>;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function isDefaultExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false);
}

function requiredParamCount(parameters: ts.NodeArray<ts.ParameterDeclaration>): number {
  return parameters.filter((p) => !p.questionToken && !p.initializer && !p.dotDotDotToken && !(ts.isIdentifier(p.name) && p.name.text === 'this')).length;
}

function membersOf(sf: ts.SourceFile, members: ts.NodeArray<ts.TypeElement | ts.EnumMember>): Map<string, number> {
  const map = new Map<string, number>();
  for (const member of members) {
    if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
      map.set(member.name.text, lineOf(sf, member));
    }
  }
  return map;
}

/** Explicitly exported symbols of a module, with call arity and member names where the syntax provides them. */
export function collectExports(path: string, text: string): Map<string, ExportedSymbol> {
  const sf = parseSource(path, text);
  const exports = new Map<string, ExportedSymbol>();
  const add = (symbol: ExportedSymbol): void => {
    const previous = exports.get(symbol.name);
    // Overloads: keep the most permissive arity, which is what callers can rely on.
    if (previous?.requiredParams !== undefined && symbol.requiredParams !== undefined) {
      exports.set(symbol.name, { ...symbol, requiredParams: Math.min(previous.requiredParams, symbol.requiredParams) });
    } else {
      exports.set(symbol.name, symbol);
    }
  };

  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) {
      add({ name: 'default', kind: 'variable', line: lineOf(sf, statement) });
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        add({ name: element.name.text, kind: 'reexport', line: lineOf(sf, element) });
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        add({ name: element.name.text, kind: 'reexport', line: lineOf(sf, element) });
      }
      continue;
    }
    if (!hasExportModifier(statement)) {
      continue;
    }
    const line = lineOf(sf, statement);
    const exportName = (name: string | undefined): string | undefined => (isDefaultExport(statement) ? 'default' : name);
    if (ts.isFunctionDeclaration(statement)) {
      const name = exportName(statement.name?.text);
      if (name) {
        add({ name, kind: 'function', line, requiredParams: requiredParamCount(statement.parameters) });
      }
    } else if (ts.isClassDeclaration(statement)) {
      const name = exportName(statement.name?.text);
      if (name) {
        add({ name, kind: 'class', line });
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      add({ name: statement.name.text, kind: 'interface', line, members: membersOf(sf, statement.members) });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const members = ts.isTypeLiteralNode(statement.type) ? membersOf(sf, statement.type.members) : undefined;
      add({ name: statement.name.text, kind: 'type', line, ...(members ? { members } : {}) });
    } else if (ts.isEnumDeclaration(statement)) {
      add({ name: statement.name.text, kind: 'enum', line, members: membersOf(sf, statement.members) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        const init = declaration.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
        add({
          name: declaration.name.text,
          kind: fn ? 'function' : 'variable',
          line: lineOf(sf, declaration),
          ...(fn ? { requiredParams: requiredParamCount(fn.parameters) } : {}),
        });
      }
    }
  }
  return exports;
}

interface ContractChange {
  readonly module: FileChange;
  readonly moduleGone: boolean;
  readonly removed: ReadonlyMap<string, ExportedSymbol>;
  readonly arity: ReadonlyMap<string, { before: number; after: number; line: number }>;
  readonly removedMembers: ReadonlyMap<string, { kind: ExportedSymbol['kind']; members: readonly string[]; line: number }>;
}

function diffExports(module: FileChange, base: Map<string, ExportedSymbol>, head: Map<string, ExportedSymbol> | undefined): ContractChange {
  const removed = new Map<string, ExportedSymbol>();
  const arity = new Map<string, { before: number; after: number; line: number }>();
  const removedMembers = new Map<string, { kind: ExportedSymbol['kind']; members: string[]; line: number }>();
  if (head) {
    for (const [name, before] of base) {
      const after = head.get(name);
      if (!after) {
        removed.set(name, before);
        continue;
      }
      if (before.requiredParams !== undefined && after.requiredParams !== undefined && after.requiredParams > before.requiredParams) {
        arity.set(name, { before: before.requiredParams, after: after.requiredParams, line: after.line });
      }
      if (before.members && after.members) {
        const gone = [...before.members.keys()].filter((m) => !after.members?.has(m));
        if (gone.length > 0) {
          removedMembers.set(name, { kind: after.kind, members: gone, line: after.line });
        }
      }
    }
  }
  return { module, moduleGone: head === undefined, removed, arity, removedMembers };
}

/**
 * Detects exported API changes (removed exports, removed members, stricter call arity, deleted or moved
 * modules) and locates in-repository importers that still depend on the old contract.
 */
export class TsContractsAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Breaking changes to exported TypeScript/JavaScript contracts and their in-repo consumers';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => !f.binary && isScriptFile(f.path) && !isTestFile(f.path) && f.status !== 'added');
  }

  async analyze({ changes, workspace, signal }: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    const contractChanges: ContractChange[] = [];
    for (const file of changes.files) {
      if (file.binary || !isScriptFile(file.path) || isTestFile(file.path) || file.status === 'added') {
        continue;
      }
      const basePath = file.oldPath ?? file.path;
      const baseText = await changes.content.read(file.path, 'base');
      if (baseText === undefined) {
        continue;
      }
      const moved = file.status === 'renamed' || file.status === 'deleted';
      const headText = moved ? undefined : await changes.content.read(file.path, 'head');
      if (!moved && headText === undefined) {
        continue;
      }
      const change = diffExports(
        { ...file, path: basePath },
        collectExports(basePath, baseText),
        headText === undefined ? undefined : collectExports(file.path, headText),
      );
      if (change.moduleGone || change.removed.size > 0 || change.arity.size > 0 || change.removedMembers.size > 0) {
        contractChanges.push(change);
      }
    }
    if (contractChanges.length === 0) {
      return out;
    }

    const changedByPath = new Map(changes.files.map((f) => [f.path, f]));
    const allFiles = await workspace.listFiles(isScriptFile);
    const files = allFiles.slice(0, MAX_IMPORTER_SCAN);
    if (allFiles.length > files.length) {
      out.limitations.push(`Consumer scan limited to ${MAX_IMPORTER_SCAN} of ${allFiles.length} source files; consumers beyond the limit were not checked.`);
    }
    const existing = new Set([...files, ...contractChanges.map((c) => c.module.path)]);
    const stems = contractChanges.map((c) => moduleStem(c.module.path));
    const tsconfig = await workspace.read('tsconfig.json');
    const aliases = tsconfig === undefined ? undefined : parsePathAliases(tsconfig);
    const aliasPrefixes = (aliases?.entries ?? []).map((e) => e.pattern.split('*')[0] ?? '').filter((p) => p.length > 0);

    for (const importerPath of files) {
      if (signal?.aborted) {
        break;
      }
      const changed = changedByPath.get(importerPath);
      if (changed?.status === 'deleted') {
        continue;
      }
      const text = changed ? await changes.content.read(importerPath, 'head') : await workspace.read(importerPath);
      // Cheap prefilter before parsing; alias specifiers (e.g. "~api") may not contain the module name.
      if (text === undefined || !(stems.some((stem) => text.includes(stem)) || aliasPrefixes.some((prefix) => text.includes(prefix)))) {
        continue;
      }
      const sf = parseSource(importerPath, text);
      for (const moduleImport of collectImports(sf)) {
        const target = resolveImport(importerPath, moduleImport.specifier, existing, aliases);
        const change = contractChanges.find((c) => c.module.path === target);
        if (!change || target === importerPath) {
          continue;
        }
        this.reportImporter(out, change, importerPath, sf, moduleImport);
      }
    }
    return out;
  }

  private reportImporter(
    out: OutputCollector,
    change: ContractChange,
    importerPath: string,
    sf: ts.SourceFile,
    moduleImport: ReturnType<typeof collectImports>[number],
  ): void {
    const modulePath = change.module.path;
    if (change.moduleGone) {
      const verb = change.module.status === 'renamed' ? 'moved' : 'deleted';
      out.add(
        staticFinding({
          analyzerId: ID,
          ruleId: 'contracts/module-removed',
          severity: 'high',
          verification: 'evidenced',
          verificationNote: `Static import resolution: "${moduleImport.specifier}" resolved to ${modulePath}, which is ${verb} in this change. Run the type-check or build to confirm.`,
          title: `Import of ${verb} module ${modulePath}`,
          description: `${importerPath} still imports "${moduleImport.specifier}", but ${modulePath} was ${verb}${change.module.status === 'renamed' ? ` to ${change.module.path}` : ''}.`,
          location: { file: importerPath, startLine: moduleImport.line },
          evidenceDescription: `${importerPath}:${moduleImport.line} imports ${modulePath}, which no longer exists at that path.`,
          evidenceLocations: [{ file: importerPath, startLine: moduleImport.line }],
        }),
      );
      return;
    }
    for (const binding of moduleImport.bindings) {
      const names = binding.imported === '*' ? namespaceUsages(sf, binding.local) : [{ name: binding.imported, line: binding.line, local: binding.local }];
      for (const usage of names) {
        const removed = change.removed.get(usage.name);
        if (removed) {
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: 'contracts/export-removed',
              severity: 'high',
              verification: 'evidenced',
              verificationNote: `Static analysis: "${usage.name}" was exported by ${modulePath} in the base revision, is not exported in head, and is referenced here. Run the type-check or build to confirm.`,
              title: `"${usage.name}" is no longer exported by ${modulePath}`,
              description: `${importerPath} depends on the ${removed.kind} "${usage.name}", which this change removed or renamed in ${modulePath}.`,
              location: { file: importerPath, startLine: usage.line },
              evidenceDescription: `Base ${modulePath}:${removed.line} exported "${usage.name}"; head does not. Referenced at ${importerPath}:${usage.line}.`,
              evidenceLocations: [{ file: importerPath, startLine: usage.line }],
            }),
          );
          continue;
        }
        const arity = change.arity.get(usage.name);
        if (arity) {
          for (const call of callsWithFewerArgs(sf, usage.local, binding.imported === '*' ? binding.local : undefined, usage.name, arity.after)) {
            out.add(
              staticFinding({
                analyzerId: ID,
                ruleId: 'contracts/arity-increased',
                severity: 'high',
                verification: 'evidenced',
                verificationNote: `Static analysis: "${usage.name}" now requires ${arity.after} argument(s) (was ${arity.before}); this call passes ${call.args}.`,
                title: `Call to "${usage.name}" is missing required arguments`,
                description: `${modulePath} changed the signature of "${usage.name}" to require ${arity.after} argument(s), but this call site was not updated.`,
                location: { file: importerPath, startLine: call.line },
                evidenceDescription: `${importerPath}:${call.line} passes ${call.args} argument(s); ${modulePath}:${arity.line} requires ${arity.after}.`,
              }),
            );
          }
        }
        const members = change.removedMembers.get(usage.name);
        if (members) {
          const accessor = members.kind === 'enum' ? usage.local : undefined;
          for (const hit of memberUsages(sf, members.members, accessor)) {
            const enumAccess = accessor !== undefined;
            out.add(
              staticFinding({
                analyzerId: ID,
                ruleId: enumAccess ? 'contracts/enum-member-removed' : 'contracts/property-removed',
                severity: enumAccess ? 'high' : 'medium',
                verification: enumAccess ? 'evidenced' : 'suspected',
                verificationNote: enumAccess
                  ? `Static analysis: ${usage.name}.${hit.member} was removed from ${modulePath} and is accessed here.`
                  : `Name-based match without type resolution: "${hit.member}" was removed from ${usage.name} and a property with that name is used in a file importing it. A type-check can confirm.`,
                title: enumAccess ? `Removed enum member ${usage.name}.${hit.member} still used` : `Possible use of removed property "${hit.member}" of ${usage.name}`,
                description: `${modulePath} removed "${hit.member}" from ${members.kind} ${usage.name}; ${importerPath} still references it.`,
                location: { file: importerPath, startLine: hit.line },
                evidenceDescription: `Member "${hit.member}" removed from ${usage.name} (${modulePath}:${members.line}); referenced at ${importerPath}:${hit.line}.`,
              }),
            );
          }
        }
      }
    }
  }
}

function moduleStem(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  if (file === 'index') {
    const dir = path.slice(0, path.lastIndexOf('/'));
    return dir.slice(dir.lastIndexOf('/') + 1);
  }
  return file;
}

/** `ns.foo` usages of a namespace import. */
function namespaceUsages(sf: ts.SourceFile, namespace: string): { name: string; line: number; local: string }[] {
  const usages: { name: string; line: number; local: string }[] = [];
  visit(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === namespace) {
      usages.push({ name: node.name.text, line: lineOf(sf, node), local: node.name.text });
    }
  });
  return usages;
}

function callsWithFewerArgs(sf: ts.SourceFile, local: string, namespace: string | undefined, name: string, required: number): { line: number; args: number }[] {
  const calls: { line: number; args: number }[] = [];
  visit(sf, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.some((a) => ts.isSpreadElement(a))) {
      return;
    }
    const callee = node.expression;
    const matches = namespace
      ? ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === namespace && callee.name.text === name
      : ts.isIdentifier(callee) && callee.text === local;
    if (matches && node.arguments.length < required) {
      calls.push({ line: lineOf(sf, node), args: node.arguments.length });
    }
  });
  return calls;
}

/** Property accesses / object-literal keys named like a removed member; with an accessor, only `Accessor.member`. */
function memberUsages(sf: ts.SourceFile, members: readonly string[], accessor: string | undefined): { member: string; line: number }[] {
  const wanted = new Set(members);
  const hits: { member: string; line: number }[] = [];
  visit(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) && wanted.has(node.name.text)) {
      if (accessor === undefined || (ts.isIdentifier(node.expression) && node.expression.text === accessor)) {
        hits.push({ member: node.name.text, line: lineOf(sf, node) });
      }
    } else if (accessor === undefined && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text) && ts.isObjectLiteralExpression(node.parent)) {
      hits.push({ member: node.name.text, line: lineOf(sf, node) });
    } else if (accessor === undefined && ts.isBindingElement(node) && wanted.has((node.propertyName ?? node.name).getText(sf))) {
      hits.push({ member: (node.propertyName ?? node.name).getText(sf), line: lineOf(sf, node) });
    }
  });
  return hits;
}
