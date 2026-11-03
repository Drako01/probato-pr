import { describe, expect, it, vi } from 'vitest';
import { TsContractsAnalyzer } from '../../src/analyzers/ts-contracts';
import { SemanticContracts } from '../../src/analyzers/ts-semantic';
import { ReviewCache, withIncrementalCache } from '../../src/infrastructure/review-cache';
import { ReviewEngine } from '../../src/core/review-engine';
import { changeSetOf, workspaceOf } from './helpers';

const original = 'export function load(id: string) { return id; }';
const removed = 'export function replacement(id: string) { return id; }';
async function analyze(head: string, workspace: Record<string, string>) {
  const changes = changeSetOf([{ path: 'src/api.ts', base: original, head }]);
  return new TsContractsAnalyzer().analyze({ changes, workspace: workspaceOf({ 'src/api.ts': head, ...workspace }) });
}

describe('snapshot-only semantic contracts', () => {
  it('follows export-star and renamed barrels to stale consumers', async () => {
    const result = await analyze(removed, {
      'src/barrel.ts': "export * from './api';",
      'src/public.ts': "export { load as getUser } from './barrel';",
      'src/page.ts': "import { getUser } from './public'; getUser('1');",
    });
    expect(result.findings.some((finding) => finding.location.file === 'src/page.ts' && finding.ruleId === 'contracts/export-removed')).toBe(true);
    expect(result.evidence.some((evidence) => evidence.locations.some((location) => location.file === 'src/api.ts') && evidence.locations.some((location) => location.file === 'src/page.ts'))).toBe(true);
    expect(result.findings.every((finding) => finding.verification !== 'confirmed')).toBe(true);
  });

  it('checks indirect call arity but rejects shadowed local names', async () => {
    const result = await analyze('export function load(id: string, locale: string) { return id + locale; }', {
      'src/barrel.ts': "export { load as getUser } from './api';",
      'src/page.ts': "import { getUser } from './barrel'; getUser('1'); function local(getUser: (x: string) => string) { getUser('2'); }",
    });
    expect(result.findings.filter((finding) => finding.location.file === 'src/page.ts' && finding.ruleId === 'contracts/arity-increased')).toHaveLength(1);
  });

  it('resolves call positions from the changed consumer snapshot and rejects newly shadowed names', async () => {
    const before = "import { getUser } from './barrel'; getUser('1');";
    const after = "import { getUser } from './barrel';\n// changed consumer layout\ngetUser('1'); function local(getUser: (x: string) => string) { getUser('2'); }";
    const changes = changeSetOf([
      { path: 'src/api.ts', base: original, head: 'export function load(id: string, locale: string) { return id + locale; }' },
      { path: 'src/page.ts', base: before, head: after },
    ]);
    const result = await new TsContractsAnalyzer().analyze({ changes, workspace: workspaceOf({
      'src/api.ts': 'export function load(id: string, locale: string) { return id + locale; }',
      'src/barrel.ts': "export { load as getUser } from './api';", 'src/page.ts': after,
    }) });
    const findings = result.findings.filter((finding) => finding.location.file === 'src/page.ts' && finding.ruleId === 'contracts/arity-increased');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.startLine).toBe(3);
  });

  it('does not build a partial semantic graph when bounded source contents are unavailable', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const result = await SemanticContracts.create({ changes, workspace: { listFiles: () => Promise.resolve(['src/api.ts', 'src/unreadable.ts']), read: () => Promise.resolve(undefined) } });
    expect(result.graph).toBeUndefined();
    expect(result.limitations.join(' ')).toContain('unavailable');
  });

  it('resolves inherited local tsconfig aliases and workspace package exports', async () => {
    const result = await analyze(removed, {
      'tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@api":["src/api.ts"]}}}',
      'tsconfig.json': '{"extends":"./tsconfig.base.json"}',
      'packages/client/package.json': '{"name":"@workspace/client","exports":{".":{"types":"./src/index.ts"}}}',
      'packages/client/src/index.ts': "export { load as getUser } from '@api';",
      'src/page.ts': "import { getUser } from '@workspace/client'; getUser('1');",
    });
    expect(result.findings.some((finding) => finding.location.file === 'src/page.ts')).toBe(true);
  });

  it('does not infer relationships from ambiguous duplicate workspace package names', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const graph = await SemanticContracts.create({ changes, workspace: workspaceOf({
      'packages/a/package.json': '{"name":"@workspace/shared","types":"index.ts"}',
      'packages/a/index.ts': "export { load } from '../../src/api';",
      'packages/b/package.json': '{"name":"@workspace/shared","types":"index.ts"}',
      'packages/b/index.ts': "export function load() {}",
      'src/page.ts': "import { load } from '@workspace/shared'; load('1');",
    }) });
    expect(graph.graph?.origin('src/page.ts', '@workspace/shared', 'load')).toBeUndefined();
    expect(graph.limitations.join(' ')).toContain('ambiguous');
  });

  it('respects package exports boundaries instead of inferring private subpaths', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const graph = await SemanticContracts.create({ changes, workspace: workspaceOf({
      'packages/client/package.json': '{"name":"@workspace/client","exports":{".":"./src/index.ts"}}',
      'packages/client/src/index.ts': "export { load } from '../../../src/api';",
      'packages/client/private.ts': "export { load } from '../../src/api';",
      'src/page.ts': "import { load } from '@workspace/client/private'; load('1');",
    }) });
    expect(graph.graph?.origin('src/page.ts', '@workspace/client/private', 'load')).toBeUndefined();
  });

  it('does not attribute a barrel redirected to a replacement implementation', async () => {
    const changes = changeSetOf([
      { path: 'src/api.ts', base: original, head: removed },
      { path: 'src/barrel.ts', base: "export { load } from './api';", head: "export { load } from './replacement';" },
    ]);
    const result = await new TsContractsAnalyzer().analyze({ changes, workspace: workspaceOf({
      'src/api.ts': removed,
      'src/barrel.ts': "export { load } from './replacement';",
      'src/replacement.ts': original,
      'src/page.ts': "import { load } from './barrel'; load('1');",
    }) });
    expect(result.findings.filter((finding) => finding.location.file === 'src/page.ts')).toHaveLength(0);
  });

  it('never resolves external files and reports unsupported config inheritance', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const context = { changes, workspace: workspaceOf({ 'src/api.ts': removed, 'tsconfig.json': '{"extends":"some-external-config"}', 'src/page.ts': "import { readFile } from 'node:fs';" }) };
    const result = await SemanticContracts.create(context);
    expect(result.graph?.origin('src/page.ts', 'node:fs', 'readFile')).toBeUndefined();
    expect(result.limitations.join(' ')).toContain('Package-based');
  });

  it('falls back when the bounded semantic snapshot is unavailable', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const graph = await SemanticContracts.create({ changes, workspace: { listFiles: () => Promise.resolve(Array.from({ length: 5001 }, (_, i) => `src/${i}.ts`)), read: vi.fn() } });
    expect(graph.graph).toBeUndefined();
    expect(graph.limitations.join(' ')).toContain('limited');
  });
});

describe('shared incremental snapshot work', () => {
  it('reads unchanged sources once per review and never rereads changed head via workspace', async () => {
    const changes = changeSetOf([{ path: 'src/api.ts', base: original, head: removed }]);
    const read = vi.fn((file: string) => Promise.resolve(file === 'src/page.ts' ? "import { load } from './api';" : removed));
    const workspace = { listFiles: () => Promise.resolve(['src/api.ts', 'src/page.ts']), read };
    const analyzer = { id: 'first', description: 'first', appliesTo: () => true, analyze: vi.fn(() => Promise.resolve({ findings: [], evidence: [] })) };
    const other = { ...analyzer, id: 'second' };
    const engine = new ReviewEngine(withIncrementalCache([analyzer, other], 'test', new ReviewCache()), 'test');
    await engine.review(changes, workspace);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('src/page.ts');
    await engine.review(changes, workspace);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
