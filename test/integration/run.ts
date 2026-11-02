// Launches a real VS Code (Extension Development Host) once per scenario against generated fixture
// repositories and runs the mocha suite inside it. Each launch uses isolated user-data/extensions dirs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** Repository whose uncommitted change breaks a consumer (src/profile.ts:1). */
function brokenRepo(root: string): void {
  write(root, {
    'src/api.ts': 'export function getUserName(id: string): string { return id; }\n',
    'src/profile.ts': "import { getUserName } from './api';\nexport const label = getUserName('1');\n",
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  write(root, { 'src/api.ts': 'export function getDisplayName(id: string): string { return id; }\n' });
}

function cleanRepo(root: string): void {
  write(root, { 'README.md': '# clean\n' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
}

interface Scenario {
  readonly name: 'single' | 'restricted' | 'multiroot';
  /** Returns the path VS Code opens (folder or .code-workspace) plus env for the suite. */
  setup(sandbox: string): { open: string; env: Record<string, string> };
  readonly trusted: boolean;
  readonly optIn?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'single',
    trusted: true,
    setup: (sandbox) => {
      const repo = path.join(sandbox, 'fixture repo');
      brokenRepo(repo);
      return { open: repo, env: { PROBATO_FIXTURE: repo } };
    },
  },
  {
    // Opt-in only (PROBATO_SCENARIO=restricted): VS Code does not enforce Workspace Trust in the Extension
    // Development Host (isTrusted stays true), so this cannot pass there. Kept to document the limitation;
    // Restricted Mode is verified manually with the installed VSIX (docs/MANUAL_TEST_PLAN.md).
    name: 'restricted',
    optIn: true,
    trusted: false,
    setup: (sandbox) => {
      const repo = path.join(sandbox, 'untrusted repo');
      brokenRepo(repo);
      // Restricted Mode without the blocking startup dialog.
      write(path.join(sandbox, 'user-data', 'User'), {
        'settings.json': JSON.stringify({ 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' }),
      });
      return { open: repo, env: { PROBATO_FIXTURE: repo } };
    },
  },
  {
    name: 'multiroot',
    trusted: true,
    setup: (sandbox) => {
      const broken = path.join(sandbox, 'repo-a');
      const clean = path.join(sandbox, 'repo-b');
      const plain = path.join(sandbox, 'not-a-repo');
      brokenRepo(broken);
      cleanRepo(clean);
      write(plain, { 'notes.txt': 'x\n' });
      const workspaceFile = path.join(sandbox, 'multi.code-workspace');
      writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: broken }, { path: clean }, { path: plain }] }));
      return { open: workspaceFile, env: { PROBATO_REPO_A: broken, PROBATO_REPO_B: clean, PROBATO_PLAIN: plain } };
    },
  },
];

async function main(): Promise<void> {
  // Inherited when launched from a VS Code integrated terminal or extension host; it would make Code.exe start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const only = process.env.PROBATO_SCENARIO;
  for (const scenario of SCENARIOS.filter((s) => (only ? s.name === only : !s.optIn))) {
    const sandbox = mkdtempSync(path.join(tmpdir(), `probato-it-${scenario.name}-`));
    try {
      const { open, env } = scenario.setup(sandbox);
      console.log(`\n=== scenario: ${scenario.name} ===`);
      await runTests({
        ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
        // PROBATO_EXTENSION_PATH points at an extracted VSIX to test exactly what is shipped.
        extensionDevelopmentPath: process.env.PROBATO_EXTENSION_PATH ?? path.resolve(__dirname, '../..'),
        extensionTestsPath: path.resolve(__dirname, 'suite.js'),
        launchArgs: [
          open,
          '--disable-extensions',
          ...(scenario.trusted ? ['--disable-workspace-trust'] : []),
          `--user-data-dir=${path.join(sandbox, 'user-data')}`,
          `--extensions-dir=${path.join(sandbox, 'extensions')}`,
        ],
        // GIT_CEILING_DIRECTORIES keeps git from discovering repositories above the sandbox (e.g. a home dir under Git).
        extensionTestsEnv: { ...env, PROBATO_SCENARIO: scenario.name, GIT_CEILING_DIRECTORIES: sandbox },
      });
    } finally {
      // VS Code child processes can hold handles briefly after exit (EPERM/EBUSY on Windows).
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
