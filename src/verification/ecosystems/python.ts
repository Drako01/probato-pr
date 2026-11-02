import { tr } from '../../core/i18n';
import type { CheckKind, OutputFormat } from '../../core/model';
import { anyExists, toolCheck, type CheckDraft, type Ecosystem, type ProjectProbe } from './shared';

const PROJECT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const VENV_DIRS = ['.venv', 'venv', 'env'];

interface Interpreter {
  /** Repository-relative path inside a virtual environment, or a command name on PATH. */
  readonly executable: string;
  /** Directory with the environment's console scripts, to tell whether a tool is installed there. */
  readonly binDir?: string;
}

async function interpreterOf(probe: ProjectProbe, platform: NodeJS.Platform): Promise<Interpreter> {
  for (const dir of VENV_DIRS) {
    const binDir = platform === 'win32' ? `${dir}/Scripts` : `${dir}/bin`;
    const executable = platform === 'win32' ? `${binDir}/python.exe` : `${binDir}/python`;
    if (await probe.exists(executable)) {
      return { executable, binDir };
    }
  }
  return { executable: platform === 'win32' ? 'python' : 'python3' };
}

interface PythonTool {
  readonly kind: CheckKind;
  readonly module: string;
  readonly format: OutputFormat;
  readonly runsRepositoryCode: boolean;
  /** Whether the project configures this tool, from its config files. */
  readonly configured: (configs: ProjectConfigs, probe: ProjectProbe) => Promise<boolean>;
  readonly args: (configs: ProjectConfigs) => readonly string[];
}

interface ProjectConfigs {
  readonly pyproject: string;
  readonly setupCfg: string;
  readonly toxIni: string;
  readonly mypyIni: string;
}

const TOOLS: readonly PythonTool[] = [
  {
    kind: 'typecheck',
    module: 'mypy',
    format: 'gnu',
    runsRepositoryCode: true, // mypy plugins configured in the project are Python code
    configured: async (c, probe) => /^\[tool\.mypy\]/m.test(c.pyproject) || /^\[mypy\]/m.test(c.setupCfg) || (await probe.exists('mypy.ini')),
    // Without a configured file list, check the whole tree but never virtual environments or build output.
    args: (c) => [
      '--show-column-numbers',
      '--no-error-summary',
      '--no-pretty',
      ...(/^\s*files\s*=/m.test(`${c.pyproject}\n${c.setupCfg}\n${c.mypyIni}`) ? [] : ['--exclude', '(^|/)(\\.?venv|env|build|dist)/', '.']),
    ],
  },
  {
    kind: 'lint',
    module: 'ruff',
    format: 'gnu',
    runsRepositoryCode: false,
    configured: async (c, probe) => /^\[tool\.ruff/m.test(c.pyproject) || (await anyExists(probe, ['ruff.toml', '.ruff.toml'])),
    args: () => ['check', '--output-format=concise', '.'],
  },
  {
    kind: 'test',
    module: 'pytest',
    format: 'plain',
    runsRepositoryCode: true,
    configured: async (c, probe) =>
      /^\[tool\.pytest/m.test(c.pyproject) || /^\[(?:tool:)?pytest\]/m.test(`${c.setupCfg}\n${c.toxIni}`) || (await anyExists(probe, ['pytest.ini', 'conftest.py', 'tests'])),
    args: () => [],
  },
];

/**
 * mypy, ruff and pytest when the project configures them, run with the project's virtual environment when
 * there is one (`.venv`, `venv`, `env`) and the tool is installed in it, or with the interpreter on PATH.
 */
export const pythonChecks: Ecosystem = async ({ probe, platform }) => {
  if (!(await anyExists(probe, PROJECT_MARKERS))) {
    return [];
  }
  const read = async (p: string) => (await probe.readText(p)) ?? '';
  const configs: ProjectConfigs = { pyproject: await read('pyproject.toml'), setupCfg: await read('setup.cfg'), toxIni: await read('tox.ini'), mypyIni: await read('mypy.ini') };
  const interpreter = await interpreterOf(probe, platform);
  const environmentNote = interpreter.binDir
    ? tr('Uses the virtual environment in {0}.', interpreter.binDir.split('/')[0] ?? '')
    : tr('No virtual environment found (.venv, venv, env): the interpreter on PATH is used, and the tool must be installed for it.');

  const drafts: CheckDraft[] = [];
  for (const tool of TOOLS) {
    if (!(await tool.configured(configs, probe))) {
      continue;
    }
    if (interpreter.binDir && !(await probe.exists(`${interpreter.binDir}/${tool.module}${platform === 'win32' ? '.exe' : ''}`))) {
      continue; // configured but not installed in the project's environment: running it would only fail
    }
    const args = ['-m', tool.module, ...tool.args(configs)];
    drafts.push(
      toolCheck({
        id: `python:${tool.module}`,
        kind: tool.kind,
        label: `python -m ${tool.module}`,
        command: { executable: interpreter.executable, args },
        rationale: tr('{0} is configured in the project. {1}', tool.module, environmentNote),
        warnings: tool.runsRepositoryCode ? [tr('Imports and runs repository code.')] : [],
        outputFormat: tool.format,
        runsRepositoryCode: tool.runsRepositoryCode,
      }),
    );
  }
  return drafts;
};
