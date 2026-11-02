import * as ts from 'typescript';
import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import type { ChangeSet } from '../core/model';
import { addedLines } from '../git/diff-parser';
import { isAnalyzableScript, isTestFile, lineOf, lineText, parseSource, visit } from './ts-ast';

const ID = 'error-handling';
const SUPPRESSION = /(?:\/\/|\/\*)\s*(@ts-ignore|@ts-nocheck|eslint-disable(?:-next-line|-line)?)(?!\S)/;

function isEmptyFunction(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return false;
  }
  return ts.isBlock(node.body) && node.body.statements.length === 0;
}

/** Errors swallowed by new code, and type/lint checks suppressed on added lines. */
export class ErrorHandlingAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Swallowed errors and suppressed type/lint checks introduced by the change';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => isAnalyzableScript(f) && f.status !== 'deleted');
  }

  async analyze({ changes }: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    for (const file of changes.files) {
      if (!isAnalyzableScript(file) || file.status === 'deleted') {
        continue;
      }
      const added = addedLines(file);
      if (added.length === 0) {
        continue;
      }
      const addedSet = new Set(added.map((l) => l.line));

      for (const { line, text } of added) {
        const match = SUPPRESSION.exec(text);
        if (match?.[1]) {
          const directive = match[1];
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: directive.startsWith('@ts') ? 'errors/type-check-suppressed' : 'errors/lint-suppressed',
              severity: directive === '@ts-nocheck' ? 'medium' : 'low',
              verification: 'evidenced',
              verificationNote: `The directive "${directive}" appears on a line added by this change.`,
              title: `${directive} added in ${file.path}`,
              description:
                directive === '@ts-nocheck'
                  ? 'Type checking is disabled for the whole file, so type errors introduced now or later go unnoticed.'
                  : 'A compiler or linter diagnostic is silenced instead of fixed; the underlying problem is hidden, not resolved.',
              location: { file: file.path, startLine: line },
              evidenceDescription: `Added line ${line}: ${text.trim().slice(0, 200)}`,
              excerpt: text.trim().slice(0, 200),
            }),
          );
        }
      }

      if (isTestFile(file.path)) {
        continue;
      }
      const headText = await changes.content.read(file.path, 'head');
      if (headText === undefined) {
        continue;
      }
      const sf = parseSource(file.path, headText);
      visit(sf, (node) => {
        if (ts.isCatchClause(node) && node.block.statements.length === 0) {
          const line = lineOf(sf, node);
          if (!addedSet.has(line)) {
            return;
          }
          const commented = /\/\/|\/\*/.test(node.block.getText(sf));
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: 'errors/empty-catch',
              severity: commented ? 'low' : 'medium',
              verification: 'evidenced',
              verificationNote: 'AST shows a catch clause with no statements on a line added by this change.',
              title: `Empty catch block in ${file.path}`,
              description: commented
                ? 'The error is intentionally ignored (the block only has a comment). Confirm that failure here is truly harmless.'
                : 'The error is silently discarded: failures will look like successes and be hard to diagnose.',
              location: { file: file.path, startLine: line },
              evidenceDescription: `Line ${line}: ${lineText(sf, line).slice(0, 200)}`,
              suggestedFix: 'Handle the error, rethrow it with context, or at least log it with enough detail to diagnose.',
            }),
          );
        } else if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'catch' &&
          node.arguments[0] !== undefined &&
          isEmptyFunction(node.arguments[0])
        ) {
          const line = lineOf(sf, node.expression.name);
          if (!addedSet.has(line)) {
            return;
          }
          out.add(
            staticFinding({
              analyzerId: ID,
              ruleId: 'errors/empty-promise-catch',
              severity: 'medium',
              verification: 'evidenced',
              verificationNote: 'AST shows .catch() with an empty handler on a line added by this change.',
              title: `Promise rejection swallowed in ${file.path}`,
              description: 'The rejection is discarded by an empty handler, hiding failures from callers and logs.',
              location: { file: file.path, startLine: line },
              evidenceDescription: `Line ${line}: ${lineText(sf, line).slice(0, 200)}`,
            }),
          );
        }
      });
    }
    return out;
  }
}
