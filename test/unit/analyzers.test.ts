import { describe, expect, it } from 'vitest';
import { ConfigRiskAnalyzer } from '../../src/analyzers/config-risk';
import { DependenciesAnalyzer, majorOf } from '../../src/analyzers/dependencies';
import { ErrorHandlingAnalyzer } from '../../src/analyzers/error-handling';
import { SecretsAnalyzer } from '../../src/analyzers/secrets';
import { collectTestCases, TestIntegrityAnalyzer } from '../../src/analyzers/test-integrity';
import { TsContractsAnalyzer } from '../../src/analyzers/ts-contracts';
import { EMPTY_WORKSPACE } from '../../src/core/analyzer';
import { changeSetOf, workspaceOf } from './helpers';

describe('TsContractsAnalyzer', () => {
  const analyzer = new TsContractsAnalyzer();

  it('Case A: reports a consumer still using a renamed export (evidenced, at the consumer line)', async () => {
    const changes = changeSetOf([
      {
        path: 'src/api/user.ts',
        base: 'export function getUserName(id: string) { return id; }\n',
        head: 'export function getDisplayName(id: string) { return id; }\n',
      },
    ]);
    const workspace = workspaceOf({
      'src/api/user.ts': 'export function getDisplayName(id: string) { return id; }\n',
      'src/ui/profile.ts': "import { getUserName } from '../api/user';\n\nexport const label = getUserName('1');\n",
      'src/ui/unrelated.ts': "import { other } from './other';\n",
    });
    const { findings } = await analyzer.analyze({ changes, workspace });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'contracts/export-removed',
      verification: 'evidenced',
      location: { file: 'src/ui/profile.ts', startLine: 1 },
    });
  });

  it('reports call sites that pass fewer arguments than the new signature requires', async () => {
    const changes = changeSetOf([
      { path: 'src/math.ts', base: 'export const add = (a: number) => a;\n', head: 'export const add = (a: number, b: number) => a + b;\n' },
    ]);
    const workspace = workspaceOf({
      'src/main.ts': "import { add } from './math.js';\nadd(1);\nadd(1, 2);\n",
    });
    const { findings } = await analyzer.analyze({ changes, workspace });
    expect(findings.map((f) => [f.ruleId, f.location.startLine])).toEqual([['contracts/arity-increased', 2]]);
  });

  it('reports removed enum members (evidenced) and removed interface properties (suspected)', async () => {
    const changes = changeSetOf([
      {
        path: 'src/types.ts',
        base: 'export enum Role { Admin, Guest }\nexport interface User { id: string; email: string }\n',
        head: 'export enum Role { Admin }\nexport interface User { id: string }\n',
      },
    ]);
    const workspace = workspaceOf({
      'src/use.ts': "import { Role, type User } from './types';\nconst r = Role.Guest;\nfunction f(u: User) { return u.email; }\n",
    });
    const { findings } = await analyzer.analyze({ changes, workspace });
    const byRule = Object.fromEntries(findings.map((f) => [f.ruleId, f.verification]));
    expect(byRule).toEqual({ 'contracts/enum-member-removed': 'evidenced', 'contracts/property-removed': 'suspected' });
  });

  it('resolves tsconfig path aliases (JSONC with comments) to find consumers', async () => {
    const changes = changeSetOf([{ path: 'src/api/user.ts', base: 'export const getUser = () => 1;\n', head: 'export const fetchUser = () => 1;\n' }]);
    const workspace = workspaceOf({
      'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~api": ["src/api/user.ts"] } }\n}\n',
      'src/api/user.ts': 'export const fetchUser = () => 1;\n',
      'src/ui/a.tsx': "import { getUser } from '@/api/user';\nexport const A = getUser();\n",
      'src/ui/b.ts': "import { getUser } from '~api';\n",
      'src/ui/c.ts': "import { getUser } from 'some-package';\n",
    });
    const { findings } = await analyzer.analyze({ changes, workspace });
    expect(findings.map((f) => f.location.file).sort()).toEqual(['src/ui/a.tsx', 'src/ui/b.ts']);
  });

  it('reports imports of a deleted module', async () => {
    const changes = changeSetOf([{ path: 'src/legacy.ts', base: 'export const x = 1;\n' }]);
    const workspace = workspaceOf({ 'src/app.ts': "import { x } from './legacy';\n" });
    const { findings } = await analyzer.analyze({ changes, workspace });
    expect(findings[0]?.ruleId).toBe('contracts/module-removed');
  });

  it('stays silent when the export removal also removed every usage (no noise)', async () => {
    const changes = changeSetOf([{ path: 'src/a.ts', base: 'export const old = 1;\nexport const keep = 2;\n', head: 'export const keep = 2;\n' }]);
    const workspace = workspaceOf({ 'src/b.ts': "import { keep } from './a';\n" });
    const { findings } = await analyzer.analyze({ changes, workspace });
    expect(findings).toEqual([]);
  });
});

describe('TestIntegrityAnalyzer', () => {
  const analyzer = new TestIntegrityAnalyzer();
  const base = `describe('cart', () => {
  it('adds items', () => { expect(add()).toBe(1); expect(total()).toBe(2); });
  it('removes items', () => { expect(remove()).toBe(0); });
  it('clears', () => { expect(clear()).toBe(true); });
});
`;

  it('collects titles, assertions and modes from the AST', () => {
    const cases = collectTestCases('cart.test.ts', base);
    expect(cases.map((c) => [c.title, c.assertions, c.mode])).toEqual([
      ['cart > adds items', 2, 'normal'],
      ['cart > removes items', 1, 'normal'],
      ['cart > clears', 1, 'normal'],
    ]);
  });

  it('flags focused, skipped, removed and assertion-free tests', async () => {
    const head = `describe('cart', () => {
  it.only('adds items', () => { expect(add()).toBe(1); expect(total()).toBe(2); });
  it.skip('removes items', () => { expect(remove()).toBe(0); });
});
`;
    const { findings } = await analyzer.analyze({ changes: changeSetOf([{ path: 'src/cart.test.ts', base, head }]), workspace: EMPTY_WORKSPACE });
    expect(findings.map((f) => f.ruleId).sort()).toEqual(['tests/cases-removed', 'tests/focused', 'tests/skipped']);

    const hollow = base.replace("expect(clear()).toBe(true);", 'clear();');
    const second = await analyzer.analyze({ changes: changeSetOf([{ path: 'src/cart.test.ts', base, head: hollow }]), workspace: EMPTY_WORKSPACE });
    expect(second.findings.map((f) => [f.ruleId, f.location.startLine])).toEqual([['tests/assertions-removed', 4]]);
  });

  it('flags deleted test files and Go skips', async () => {
    const { findings } = await analyzer.analyze({
      changes: changeSetOf([
        { path: 'src/cart.spec.ts', base },
        { path: 'pkg/cart_test.go', base: 'func TestAdd(t *testing.T) {\n}\n', head: 'func TestAdd(t *testing.T) {\n\tt.Skip("flaky")\n}\n' },
      ]),
      workspace: EMPTY_WORKSPACE,
    });
    expect(findings.map((f) => f.ruleId).sort()).toEqual(['tests/file-deleted', 'tests/skipped']);
  });

  it('accepts a refactor that keeps all tests and assertions', async () => {
    const head = base.replace('adds items', 'adds items').replace('  it(', '\n  it(');
    const { findings } = await analyzer.analyze({ changes: changeSetOf([{ path: 'src/cart.test.ts', base, head }]), workspace: EMPTY_WORKSPACE });
    expect(findings).toEqual([]);
  });
});

describe('SecretsAnalyzer', () => {
  const analyzer = new SecretsAnalyzer();
  const key = `AKIA${'Q'.repeat(16)}`;

  it('reports a credential only on the added line, with a redacted excerpt', async () => {
    const changes = changeSetOf([{ path: 'src/config.ts', base: 'export const region = "us";\n', head: `export const region = "us";\nexport const key = "${key}";\n` }]);
    const { findings, evidence } = await analyzer.analyze({ changes, workspace: EMPTY_WORKSPACE });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', verification: 'evidenced', location: { startLine: 2 } });
    expect(evidence[0]?.excerpt).toContain('[REDACTED:aws-access-key]');
    expect(JSON.stringify({ findings, evidence })).not.toContain(key);
  });

  it('ignores secrets that already existed before the change', async () => {
    const changes = changeSetOf([{ path: 'src/config.ts', base: `const k = "${key}";\n`, head: `const k = "${key}";\nconst x = 1;\n` }]);
    const { findings } = await analyzer.analyze({ changes, workspace: EMPTY_WORKSPACE });
    expect(findings).toEqual([]);
  });

  it('reports sensitive files being added', async () => {
    const { findings } = await analyzer.analyze({ changes: changeSetOf([{ path: '.env', head: 'A=1\n' }]), workspace: EMPTY_WORKSPACE });
    expect(findings[0]?.ruleId).toBe('secrets/sensitive-file-added');
  });
});

describe('ErrorHandlingAnalyzer', () => {
  it('flags new empty catch blocks, empty promise handlers and suppressions, but not pre-existing ones', async () => {
    const base = 'try { a(); } catch {}\n';
    const head = `try { a(); } catch {}
try { b(); } catch (e) {}
p.catch(() => {});
// @ts-ignore
const x: number = 'y';
`;
    const { findings } = await new ErrorHandlingAnalyzer().analyze({ changes: changeSetOf([{ path: 'src/x.ts', base, head }]), workspace: EMPTY_WORKSPACE });
    expect(findings.map((f) => [f.ruleId, f.location.startLine]).sort()).toEqual([
      ['errors/empty-catch', 2],
      ['errors/empty-promise-catch', 3],
      ['errors/type-check-suppressed', 4],
    ]);
  });
});

describe('DependenciesAnalyzer', () => {
  it('flags install scripts, major upgrades and removed-but-imported packages', async () => {
    const base = JSON.stringify({ dependencies: { lodash: '^4.17.0', react: '^18.2.0' } }, null, 2);
    const head = JSON.stringify({ scripts: { postinstall: 'node steal.js' }, dependencies: { react: '^19.0.0' } }, null, 2);
    const changes = changeSetOf([{ path: 'package.json', base, head }]);
    const workspace = workspaceOf({ 'src/util.ts': "import debounce from 'lodash/debounce';\n" });
    const { findings } = await new DependenciesAnalyzer().analyze({ changes, workspace });
    expect(findings.map((f) => f.ruleId).sort()).toEqual(['dependencies/install-script', 'dependencies/major-upgrade', 'dependencies/removed-but-imported']);
  });

  it('parses majors from common ranges', () => {
    expect(majorOf('^4.2.0')).toBe(4);
    expect(majorOf('~1.0')).toBe(1);
    expect(majorOf('>=2')).toBe(2);
    expect(majorOf('workspace:*')).toBeUndefined();
    expect(majorOf('latest')).toBeUndefined();
  });
});

describe('ConfigRiskAnalyzer', () => {
  it('flags disabled strictness and dangerous workflow triggers', async () => {
    const changes = changeSetOf([
      { path: 'tsconfig.json', base: '{ "compilerOptions": { "strict": true } }\n', head: '{ "compilerOptions": {\n // relaxed\n "strict": false } }\n' },
      {
        path: '.github/workflows/ci.yml',
        base: 'on: push\n',
        head: 'on: pull_request_target\njobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n',
      },
    ]);
    const { findings } = await new ConfigRiskAnalyzer().analyze({ changes, workspace: EMPTY_WORKSPACE });
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['config/ts-strictness-reduced', 'high'],
      ['config/workflow-pull-request-target', 'critical'],
    ]);
  });
});
