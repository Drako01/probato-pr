import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import { matchesAnyGlob } from '../core/glob';
import type { ChangeSet, Severity } from '../core/model';
import { findSecrets, redactSecrets, SENSITIVE_FILE_GLOBS, type SecretPattern } from '../core/secrets';
import { addedLines } from '../git/diff-parser';

const ID = 'secrets';
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?|mocks?|examples?)\//i;
/** Credentials under test/fixture paths are often fake, so they rank one level lower. */
const SEVERITY: Readonly<Record<SecretPattern['confidence'], Readonly<Record<'source' | 'testPath', Severity>>>> = {
  high: { source: 'critical', testPath: 'medium' },
  medium: { source: 'medium', testPath: 'low' },
};

/** Detects credentials introduced by the change: known token formats on added lines and sensitive files added. */
export class SecretsAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Credentials and sensitive files introduced by the change';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => !f.binary || f.status === 'added');
  }

  analyze({ changes }: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    for (const file of changes.files) {
      if (file.status === 'deleted') {
        continue;
      }
      if (file.status === 'added' && matchesAnyGlob(file.path, SENSITIVE_FILE_GLOBS) && !/\.example$|\.sample$|\.template$/i.test(file.path)) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'secrets/sensitive-file-added',
            severity: 'high',
            verification: 'evidenced',
            verificationNote: 'The file name matches a credential/key file pattern and the file is new in this change. Its content was not validated.',
            title: `Sensitive file added: ${file.path}`,
            description: 'Files of this type usually hold credentials or private keys and should not be versioned.',
            location: { file: file.path, startLine: 1 },
            evidenceDescription: `New file ${file.path} matches a sensitive file pattern.`,
            suggestedFix: 'Remove the file from the change, add it to .gitignore and rotate any credential it contained.',
          }),
        );
      }
      const inTestPath = TEST_PATH.test(file.path);
      for (const { line, text } of addedLines(file)) {
        const reported = new Set<string>();
        for (const match of findSecrets(text)) {
          if (reported.has(match.pattern.id)) {
            continue;
          }
          reported.add(match.pattern.id);
          const high = match.pattern.confidence === 'high';
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: `secrets/${match.pattern.id}`,
              severity: SEVERITY[match.pattern.confidence][inTestPath ? 'testPath' : 'source'],
              verification: high ? 'evidenced' : 'suspected',
              verificationNote: high
                ? 'The added line contains a value in a known credential format. Whether the credential is live was not checked (no network calls are made).'
                : 'An assignment to a secret-like name with a literal value was added; it may be a placeholder.',
              title: `${match.pattern.label} added in ${file.path}`,
              description: high
                ? 'A credential in a recognizable format was committed. Anyone with repository access can read it, and it persists in history.'
                : 'A literal value is assigned to a name that suggests a secret.',
              location: { file: file.path, startLine: line },
              evidenceDescription: `Added line ${line} matches the "${match.pattern.label}" pattern.`,
              excerpt: redactSecrets(text.trim()).slice(0, 300),
              suggestedFix: 'Load the value from the environment or a secret store, and rotate the exposed credential.',
            }),
          );
        }
      }
    }
    return Promise.resolve(out);
  }
}
