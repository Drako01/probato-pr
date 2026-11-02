import { tr } from '../../core/i18n';
import type { CheckKind, CommandSpec, OutputFormat } from '../../core/model';
import { anyExists, toolCheck, wrapperCommand, type CheckDraft, type DetectionContext, type Ecosystem } from './shared';

interface BuildTool {
  readonly id: 'maven' | 'gradle';
  readonly manifests: readonly string[];
  /** Wrapper committed to the repository: the POSIX script and its Windows counterpart. */
  readonly wrapper: { readonly posix: string; readonly windows: string };
  readonly executable: string;
  readonly baseArgs: readonly string[];
  readonly format: OutputFormat;
  readonly tasks: readonly { readonly kind: CheckKind; readonly task: string }[];
}

const BUILD_TOOLS: readonly BuildTool[] = [
  {
    id: 'maven',
    manifests: ['pom.xml'],
    wrapper: { posix: 'mvnw', windows: 'mvnw.cmd' },
    executable: 'mvn',
    baseArgs: ['-B', '--no-transfer-progress'],
    format: 'maven',
    tasks: [
      { kind: 'build', task: 'compile' },
      { kind: 'test', task: 'test' },
    ],
  },
  {
    id: 'gradle',
    manifests: ['build.gradle', 'build.gradle.kts'],
    wrapper: { posix: 'gradlew', windows: 'gradlew.bat' },
    executable: 'gradle',
    baseArgs: ['--console=plain'],
    format: 'gnu',
    tasks: [
      { kind: 'build', task: 'assemble' },
      { kind: 'test', task: 'test' },
    ],
  },
];

async function detect(tool: BuildTool, { probe, platform }: DetectionContext): Promise<readonly CheckDraft[]> {
  if (!(await anyExists(probe, tool.manifests))) {
    return [];
  }
  const wrapperFile = platform === 'win32' ? tool.wrapper.windows : tool.wrapper.posix;
  // The wrapper is repository code: its content is part of the fingerprint, so editing it asks for approval again.
  const wrapper = await probe.readText(wrapperFile);
  const command = (task: string): CommandSpec =>
    wrapper === undefined ? { executable: tool.executable, args: [...tool.baseArgs, task] } : wrapperCommand(tool.wrapper.posix, [...tool.baseArgs, task], platform);
  const runner = wrapper === undefined ? tool.executable : `./${tool.wrapper.posix}`;
  const warnings = [
    tr('The build files and plugins are repository code that runs during the build.'),
    ...(wrapper === undefined ? [] : [tr('Runs the wrapper script committed to the repository ({0}).', wrapperFile)]),
    tr('May download dependencies if they are not cached (network).'),
  ];
  return tool.tasks.map(({ kind, task }) =>
    toolCheck({
      id: `${tool.id}:${task}`,
      kind,
      label: [runner, ...tool.baseArgs, task].join(' '),
      command: command(task),
      rationale: tr('{0} project detected; standard {1} task.', tool.id === 'maven' ? 'Maven' : 'Gradle', task),
      warnings,
      outputFormat: tool.format,
      runsRepositoryCode: true,
      ...(wrapper === undefined ? {} : { scriptBody: wrapper }),
    }),
  );
}

/** Maven and Gradle builds and tests, through the project's wrapper when it has one. */
export const javaChecks: Ecosystem = async (context) => (await Promise.all(BUILD_TOOLS.map((tool) => detect(tool, context)))).flat();
