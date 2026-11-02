import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import type { ChangeSet, FileChange } from '../core/model';
import { addedLines } from '../git/diff-parser';

const ID = 'config-risk';
const STRICT_FLAGS = ['strict', 'noImplicitAny', 'strictNullChecks', 'noUncheckedIndexedAccess'] as const;

function isTsConfig(path: string): boolean {
  return /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/.test(path);
}

function isWorkflow(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

/** Reads a boolean compiler option from a tsconfig, tolerating comments and trailing commas (JSONC). */
export function compilerFlag(text: string | undefined, flag: string): boolean | undefined {
  if (text === undefined) {
    return undefined;
  }
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '');
  const match = new RegExp(`"${flag}"\\s*:\\s*(true|false)`).exec(withoutComments);
  return match ? match[1] === 'true' : undefined;
}

/** Configuration changes that weaken safety nets: TypeScript strictness and CI workflow privileges. */
export class ConfigRiskAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Configuration changes that weaken type safety or CI security';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => isTsConfig(f.path) || isWorkflow(f.path));
  }

  async analyze({ changes }: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    for (const file of changes.files) {
      if (file.status === 'deleted' || file.binary) {
        continue;
      }
      if (isTsConfig(file.path)) {
        await this.analyzeTsConfig(file, changes, out);
      } else if (isWorkflow(file.path)) {
        this.analyzeWorkflow(file, out);
      }
    }
    return out;
  }

  private async analyzeTsConfig(file: FileChange, changes: ChangeSet, out: OutputCollector): Promise<void> {
    const [base, head] = await Promise.all([changes.content.read(file.path, 'base'), changes.content.read(file.path, 'head')]);
    for (const flag of STRICT_FLAGS) {
      if (compilerFlag(base, flag) === true && compilerFlag(head, flag) !== true) {
        const line = (head ?? '').split('\n').findIndex((l) => l.includes(`"${flag}"`)) + 1;
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'config/ts-strictness-reduced',
            severity: flag === 'strict' ? 'high' : 'medium',
            verification: 'evidenced',
            verificationNote: `"${flag}" was true in the base tsconfig and is ${compilerFlag(head, flag) === false ? 'false' : 'absent'} in head.`,
            title: `TypeScript "${flag}" disabled in ${file.path}`,
            description: 'Weakening compiler strictness lets whole classes of bugs (null access, implicit any) pass type-checking.',
            location: { file: file.path, startLine: Math.max(line, 1) },
            evidenceDescription: `${flag}: true → ${String(compilerFlag(head, flag) ?? 'unset')}`,
          }),
        );
      }
    }
  }

  /** Line-level checks on added YAML lines; no YAML parser is bundled. */
  private analyzeWorkflow(file: FileChange, out: OutputCollector): void {
    const added = addedLines(file);
    const checksOutHead = added.some((l) => /github\.event\.pull_request\.head\.(?:sha|ref)/.test(l.text));
    for (const { line, text } of added) {
      if (/\bpull_request_target\b/.test(text)) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'config/workflow-pull-request-target',
            severity: checksOutHead ? 'critical' : 'high',
            verification: checksOutHead ? 'evidenced' : 'suspected',
            verificationNote: checksOutHead
              ? 'Added lines both enable pull_request_target and reference the PR head ref/sha (line-level match).'
              : 'pull_request_target was added; whether untrusted PR code is checked out was not determined.',
            title: `pull_request_target trigger added in ${file.path}`,
            description:
              'pull_request_target runs with repository secrets and write permissions. Combined with checking out the PR head, any fork can run code with those privileges.',
            location: { file: file.path, startLine: line },
            evidenceDescription: `Added line ${line}: ${text.trim()}`,
          }),
        );
      }
      if (/^\s*permissions\s*:\s*write-all\s*$/.test(text)) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'config/workflow-write-all',
            severity: 'medium',
            verification: 'evidenced',
            verificationNote: 'An added line grants write-all permissions to the workflow token.',
            title: `Workflow granted write-all permissions in ${file.path}`,
            description: 'Grant only the scopes the job needs; a compromised step can otherwise push code or alter releases.',
            location: { file: file.path, startLine: line },
            evidenceDescription: `Added line ${line}: ${text.trim()}`,
          }),
        );
      }
    }
  }
}
