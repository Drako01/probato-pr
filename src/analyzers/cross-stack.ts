import * as ts from 'typescript';
import { parseDocument } from 'yaml';
import { mapLimit } from '../core/concurrency';
import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import { msg, tr } from '../core/i18n';
import type { ChangeSet, FileChange } from '../core/model';
import { addedLines, deletedLines } from '../git/diff-parser';
import { isScriptFile, parseSource } from './ts-ast';

const ID = 'cross-stack';
const MAX_CONSUMERS = 10_000;
const SOURCE = /\.(?:[cm]?[jt]sx?|go|php|py|java|kt|sql|prisma)$/i;
const DTO = /(?:Dto|Response|Request|Payload|Schema)$/i;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Contract { readonly name: string; readonly properties: ReadonlySet<string> }

function apiContracts(file: string, text: string): Contract[] {
  let parsed: unknown;
  if (/\.ya?ml$/i.test(file)) {
    const document = parseDocument(text, { customTags: [], uniqueKeys: true, schema: 'core' });
    if (document.errors.length > 0 || document.warnings.length > 0) { throw new Error('Invalid or unsupported OpenAPI YAML.'); }
    parsed = document.toJS({ maxAliasCount: 50 }) as unknown;
  } else { parsed = JSON.parse(text) as unknown; }
  if (typeof parsed !== 'object' || parsed === null) { return []; }
  const object = parsed as Record<string, unknown>;
  const components = object['components'];
  const schemas = typeof components === 'object' && components !== null ? (components as Record<string, unknown>)['schemas'] : object['definitions'];
  if (typeof schemas !== 'object' || schemas === null) { return []; }
  return Object.entries(schemas).flatMap(([name, schema]) => {
    if (typeof schema !== 'object' || schema === null) { return []; }
    const properties = (schema as Record<string, unknown>)['properties'];
    return typeof properties === 'object' && properties !== null ? [{ name, properties: new Set(Object.keys(properties)) }] : [];
  });
}

function dtoContracts(file: string, text: string): Contract[] {
  const contracts: Contract[] = [];
  const source = parseSource(file, text);
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) { continue; }
    if (!DTO.test(statement.name.text)) { continue; }
    const members = ts.isInterfaceDeclaration(statement) ? statement.members : ts.isTypeLiteralNode(statement.type) ? statement.type.members : undefined;
    if (!members) { continue; }
    const properties = new Set<string>();
    for (const member of members) {
      if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) { properties.add(member.name.text); }
    }
    contracts.push({ name: statement.name.text, properties });
  }
  return contracts;
}

/** Conservative cross-stack hints. Every inferred relationship remains suspected until a dedicated check proves it. */
export class CrossStackAnalyzer implements Analyzer {
  readonly id = ID;
  get description(): string { return tr('API properties, SQL migrations and tenant-filter regressions across layers'); }
  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((file) => !file.binary && (SOURCE.test(file.path) || /(?:openapi|swagger).*\.(?:json|ya?ml)$/i.test(file.path)));
  }

  async analyze(context: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    const all = await context.workspace.listFiles((file) => SOURCE.test(file) && !/(?:^|\/)(?:node_modules|vendor|dist|target)\//.test(file));
    const paths = all.slice(0, MAX_CONSUMERS);
    if (all.length > paths.length) { out.limitations.push(tr('Cross-stack consumer scan limited to {0} of {1} files.', MAX_CONSUMERS, all.length)); }
    const changedByPath = new Map(context.changes.files.map((f) => [f.path, f]));
    const texts = new Map<string, string>();
    const read = async (file: string) => {
      let text = texts.get(file);
      if (text === undefined) {
        text = (changedByPath.has(file) ? await context.changes.content.read(file, 'head') : await context.workspace.read(file)) ?? '';
        texts.set(file, text);
      }
      return text;
    };
    const sides = new Map(await mapLimit(context.changes.files, 12, async (file) => [file.path, await Promise.all([context.changes.content.read(file.path, 'base'), context.changes.content.read(file.path, 'head')])] as const, context.signal).then((entries) => entries.filter((entry) => entry !== undefined)));
    for (const file of context.changes.files) {
      if (context.signal?.aborted) { break; }
      if (file.binary || file.status === 'deleted') { continue; }
      const [before, after] = sides.get(file.path) ?? [];
      if (after === undefined) { continue; }
      if (/\.sql$/i.test(file.path)) { await this.migrations(file, paths, read, out); }
      if (before === undefined) { continue; }
      let contractsBefore: Contract[] = [], contractsAfter: Contract[] = [];
      try {
        if (/(?:openapi|swagger).*\.(?:json|ya?ml)$/i.test(file.path)) {
          contractsBefore = apiContracts(file.path, before); contractsAfter = apiContracts(file.path, after);
        } else if (isScriptFile(file.path)) {
          contractsBefore = dtoContracts(file.path, before); contractsAfter = dtoContracts(file.path, after);
        }
      } catch {
        out.limitations.push(tr('Contract file {0} could not be parsed safely; cross-stack property checks were skipped.', file.path));
      }
      for (const contract of contractsBefore) {
        const current = contractsAfter.find((c) => c.name === contract.name);
        if (!current) { continue; }
        for (const property of contract.properties) {
          if (current.properties.has(property)) { continue; }
          const usage = new RegExp(`(?:\\.\\s*${escape(property)}\\b|\\[\\s*["']${escape(property)}["']\\s*\\])`);
          for (const consumer of paths) {
            if (consumer === file.path) { continue; }
            const lines = (await read(consumer)).split('\n');
            const line = lines.findIndex((value) => usage.test(value));
            if (line < 0) { continue; }
            out.add(staticFinding({ analyzerId: ID, ruleId: 'cross-stack/api-property-removed', severity: 'high', verification: 'suspected',
              verificationNote: msg('Property {0} was removed from {1}; a property with the same name is still accessed in {2}. The consumer type relationship has not been proven.', property, contract.name, consumer),
              title: msg('Possible stale API property: {0}.{1}', contract.name, property),
              description: msg('Check whether {0}:{1} consumes the changed contract in {2}. Run the client type-check or contract tests to establish whether this is a regression.', consumer, line + 1, file.path),
              location: { file: consumer, startLine: line + 1 }, evidenceDescription: msg('Removed property {0} in {1}; remaining access at {2}:{3}.', property, file.path, consumer, line + 1),
              evidenceLocations: [{ file: file.path, startLine: addedLines(file)[0]?.line ?? 1 }, { file: consumer, startLine: line + 1 }],
            }));
            break;
          }
        }
      }
      this.tenancy(file, before, after, out);
    }
    return out;
  }

  private async migrations(file: FileChange, paths: readonly string[], read: (file: string) => Promise<string>, out: OutputCollector): Promise<void> {
    const identifier = '[`"\\[]?([A-Za-z_][\\w]*)[`"\\]]?';
    const tableIdentifier = '(?:[`"\\[]?[A-Za-z_][\\w]*[`"\\]]?\\.)?' + identifier;
    const alter = new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${tableIdentifier}\\s+(?:DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?|RENAME\\s+COLUMN\\s+)${identifier}`, 'i');
    const additions = addedLines(file);
    const statement = additions.map((line) => line.text).join('\n');
    for (const match of statement.matchAll(new RegExp(alter.source, 'gi'))) {
      const offset = statement.slice(0, match.index).split('\n').length - 1;
      const added = additions[offset];
      if (!added) { continue; }
      const table = match[1], column = match[2];
      if (!table || !column) { continue; }
      const mention = new RegExp(`\\b${escape(column)}\\b`);
      const tablePattern = new RegExp(`\\b${escape(table)}\\b`, 'i');
      for (const consumer of paths) {
        if (consumer === file.path || /(?:^|\/)(?:migrations?|sql)\//i.test(consumer) && /\.sql$/i.test(consumer)) { continue; }
        const text = await read(consumer);
        if (!tablePattern.test(text)) { continue; }
        const line = text.split('\n').findIndex((value) => mention.test(value));
        if (line < 0) { continue; }
        out.add(staticFinding({ analyzerId: ID, ruleId: 'cross-stack/sql-column-reference', severity: 'high', verification: 'suspected',
          verificationNote: msg('An added ALTER TABLE drops or renames {0}.{1}; another source file still mentions both identifiers. SQL execution and ORM mapping were not verified.', table, column),
          title: msg('Possible stale column reference: {0}.{1}', table, column), description: msg('Review {0}:{1} before applying migration {2}. A remaining query or ORM mapping may fail after this migration.', consumer, line + 1, file.path),
          location: { file: consumer, startLine: line + 1 }, evidenceDescription: msg('Migration line {0}: {1}; matching reference in {2}:{3}.', added.line, added.text.trim(), consumer, line + 1),
          evidenceLocations: [{ file: file.path, startLine: added.line }, { file: consumer, startLine: line + 1 }],
        }));
        break;
      }
    }
  }

  private tenancy(file: FileChange, before: string, after: string, out: OutputCollector): void {
    if (!SOURCE.test(file.path) || /(?:test|spec|migration)/i.test(file.path)) { return; }
    const tenant = /\b(?:tenant_?id|organization_?id|workspace_?id)\b\s*(?::|=)/gi;
    const count = (text: string) => [...text.matchAll(tenant)].length;
    const deleted = deletedLines(file).find((line) => /\b(?:tenant_?id|organization_?id|workspace_?id)\b\s*(?::|=)/i.test(line.text));
    if (!deleted || count(after) >= count(before) || !/(?:\bSELECT\b|\bUPDATE\b|\bDELETE\b|\.(?:findUnique|findFirst|findMany|findOne|where|Where|First|Find|query)\s*\()/i.test(after)) { return; }
    const line = addedLines(file)[0]?.line ?? Math.max(1, deleted.line);
    out.add(staticFinding({ analyzerId: ID, ruleId: 'cross-stack/tenant-predicate-removed', severity: 'high', verification: 'suspected',
      verificationNote: msg('A tenant identifier predicate was removed while data-access code remains. Authorization semantics and isolation tests have not been verified.'),
      title: msg('Review the removed tenant filter'), description: msg('The count of tenant predicates decreased in {0}. Check whether the remaining query is still scoped to the current tenant and run the project isolation tests.', file.path),
      location: { file: file.path, startLine: line }, evidenceDescription: msg('Removed tenant predicate: {0}', deleted.text.trim()),
    }));
  }
}
