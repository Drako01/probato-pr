import * as ts from 'typescript';
import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import type { ChangeSet, FileChange } from '../core/model';
import { addedLines, deletedLines } from '../git/diff-parser';
import { calleePath, isScriptFile, isTestFile, lineOf, parseSource, stringLiteralValue, visit } from './ts-ast';

const ID = 'test-integrity';

const TEST_FUNCTIONS = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'fit']);
const SUITE_FUNCTIONS = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe']);
const SKIP_MARKERS = new Set(['skip', 'todo']);
const FOCUS_MARKERS = new Set(['only']);

interface TestCase {
  readonly title: string;
  readonly line: number;
  readonly assertions: number;
  readonly mode: 'normal' | 'skipped' | 'focused';
}

function modeOf(path: string[]): TestCase['mode'] {
  const head = path[0] ?? '';
  if (path.some((p) => FOCUS_MARKERS.has(p)) || head === 'fit' || head === 'fdescribe') {
    return 'focused';
  }
  if (path.some((p) => SKIP_MARKERS.has(p)) || head.startsWith('x')) {
    return 'skipped';
  }
  return 'normal';
}

/** Counts each assertion chain once: `expect(x).toBe(1)` is one assertion, not two calls. */
function isAssertion(node: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(node.parent) || (ts.isCallExpression(node.parent) && node.parent.expression === node)) {
    return false; // inner link of a longer chain
  }
  const path = calleePath(node.expression);
  if (!path) {
    return false;
  }
  const root = path[0];
  return root === 'expect' || root === 'assert' || root === 'should' || (path.length > 1 && path.includes('should'));
}

/** Test cases with full titles ("suite > case"), assertion counts and skip/focus state, from the AST. */
export function collectTestCases(path: string, text: string): TestCase[] {
  const sourceFile = parseSource(path, text);
  const cases: TestCase[] = [];

  const walk = (node: ts.Node, suites: readonly string[], suiteMode: TestCase['mode']): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleePath(node.expression);
      const title = stringLiteralValue(node.arguments[0]);
      const root = callee?.[0];
      if (callee && root && title !== undefined && (SUITE_FUNCTIONS.has(root) || TEST_FUNCTIONS.has(root))) {
        const ownMode = modeOf(callee);
        const mode = ownMode !== 'normal' ? ownMode : suiteMode;
        if (SUITE_FUNCTIONS.has(root)) {
          node.arguments.slice(1).forEach((arg) => {
            walk(arg, [...suites, title], mode);
          });
          return;
        }
        let assertions = 0;
        node.arguments.slice(1).forEach((arg) => {
          visit(arg, (inner) => {
            if (ts.isCallExpression(inner) && isAssertion(inner)) {
              assertions++;
            }
          });
        });
        cases.push({ title: [...suites, title].join(' > '), line: lineOf(sourceFile, node), assertions, mode });
        return;
      }
    }
    ts.forEachChild(node, (child) => {
      walk(child, suites, suiteMode);
    });
  };
  walk(sourceFile, [], 'normal');
  return cases;
}

const GO_TEST_FUNC = /^func (Test\w+)\s*\(/;

/** Detects deleted, skipped, focused or weakened tests. */
export class TestIntegrityAnalyzer implements Analyzer {
  readonly id = ID;
  readonly description = 'Tests removed, skipped, focused or weakened by the change';

  appliesTo(changes: ChangeSet): boolean {
    return changes.files.some((f) => (isScriptFile(f.path) && isTestFile(f.path)) || f.path.endsWith('_test.go'));
  }

  async analyze({ changes }: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = new OutputCollector();
    for (const file of changes.files) {
      if (file.binary) {
        continue;
      }
      if (file.path.endsWith('_test.go')) {
        this.analyzeGo(file, out);
      } else if (isScriptFile(file.path) && isTestFile(file.path)) {
        await this.analyzeScript(file, changes, out);
      }
    }
    return out;
  }

  private async analyzeScript(file: FileChange, changes: ChangeSet, out: OutputCollector): Promise<void> {
    const [baseText, headText] = await Promise.all([
      file.status === 'added' ? undefined : changes.content.read(file.path, 'base'),
      file.status === 'deleted' ? undefined : changes.content.read(file.path, 'head'),
    ]);
    const base = baseText === undefined ? [] : collectTestCases(file.oldPath ?? file.path, baseText);
    if (file.status === 'deleted') {
      if (base.length > 0) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'tests/file-deleted',
            severity: 'high',
            verification: 'evidenced',
            verificationNote: `The base version of the file contained ${base.length} test case(s); the file is deleted in this change.`,
            title: `Test file deleted: ${file.path}`,
            description: `Deleting ${file.path} removes ${base.length} test case(s). If the covered behavior still exists, it is no longer protected.`,
            location: { file: file.path, startLine: 1 },
            evidenceDescription: `Base revision had ${base.length} test case(s): ${base.slice(0, 5).map((c) => c.title).join('; ')}${base.length > 5 ? '…' : ''}`,
          }),
        );
      }
      return;
    }
    if (headText === undefined) {
      return;
    }
    const head = collectTestCases(file.path, headText);
    const baseByTitle = new Map(base.map((c) => [c.title, c]));
    const headTitles = new Set(head.map((c) => c.title));

    const removed = base.filter((c) => !headTitles.has(c.title));
    if (removed.length > 0 && head.length < base.length) {
      out.add(
        staticFinding({
          analyzerId: ID,
          ruleId: 'tests/cases-removed',
          severity: 'medium',
          verification: 'evidenced',
          verificationNote: `Test count dropped from ${base.length} to ${head.length} (AST comparison of base and head).`,
          title: `${removed.length} test case(s) removed in ${file.path}`,
          description: `Removed: ${removed.map((c) => `"${c.title}"`).join(', ')}.`,
          location: { file: file.path, startLine: head[0]?.line ?? 1 },
          evidenceDescription: `Test cases present in base but not in head: ${removed.map((c) => c.title).join('; ')}`,
        }),
      );
    }

    for (const testCase of head) {
      const before = baseByTitle.get(testCase.title);
      if (testCase.mode === 'focused' && before?.mode !== 'focused') {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'tests/focused',
            severity: 'high',
            verification: 'evidenced',
            verificationNote: 'The AST shows a focus modifier (.only/fit/fdescribe) that was not present in the base revision.',
            title: `Focused test added: "${testCase.title}"`,
            description: 'A focused test makes the runner skip every other test in the file or suite, so CI can pass while most tests never run.',
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: `Line ${testCase.line} declares a focused test.`,
            suggestedFix: 'Remove the .only / f-prefix before merging.',
          }),
        );
      } else if (testCase.mode === 'skipped' && before && before.mode !== 'skipped') {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'tests/skipped',
            severity: 'medium',
            verification: 'evidenced',
            verificationNote: 'The test ran in the base revision and is skipped in head (AST comparison).',
            title: `Test disabled: "${testCase.title}"`,
            description: 'An existing test was disabled by this change, so the behavior it covered is no longer verified.',
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: `Line ${testCase.line}: test skipped (was active in base).`,
          }),
        );
      } else if (before && before.mode === 'normal' && testCase.mode === 'normal' && testCase.assertions < before.assertions) {
        const none = testCase.assertions === 0;
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: none ? 'tests/assertions-removed' : 'tests/assertions-reduced',
            severity: none ? 'high' : 'low',
            verification: 'evidenced',
            verificationNote: `Assertion calls in this test went from ${before.assertions} to ${testCase.assertions} (AST count of expect/assert calls).`,
            title: none ? `Test no longer asserts anything: "${testCase.title}"` : `Fewer assertions in "${testCase.title}"`,
            description: none
              ? 'The test still runs but cannot fail on wrong results, which makes it pass unconditionally.'
              : 'The test checks less than before; confirm the removed assertions were obsolete.',
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: `Assertions: base ${before.assertions}, head ${testCase.assertions}.`,
          }),
        );
      }
    }
  }

  /** Go has no AST available in-process; this is a line-level comparison of test declarations. */
  private analyzeGo(file: FileChange, out: OutputCollector): void {
    const removedNames = deletedLines(file)
      .map((l) => GO_TEST_FUNC.exec(l.text)?.[1])
      .filter((n): n is string => n !== undefined);
    const added = addedLines(file);
    const addedNames = new Set(added.map((l) => GO_TEST_FUNC.exec(l.text)?.[1]).filter((n) => n !== undefined));
    const reallyRemoved = removedNames.filter((n) => !addedNames.has(n));
    if (reallyRemoved.length > 0) {
      out.add(
        staticFinding({
          analyzerId: ID,
          ruleId: 'tests/cases-removed',
          severity: 'medium',
          verification: 'evidenced',
          verificationNote: 'Line-level diff comparison: Test function declarations were deleted and not re-added.',
          title: `${reallyRemoved.length} Go test(s) removed in ${file.path}`,
          description: `Removed: ${reallyRemoved.join(', ')}.`,
          location: { file: file.path, startLine: 1 },
          evidenceDescription: `Deleted declarations: ${reallyRemoved.join(', ')}`,
        }),
      );
    }
    for (const line of added) {
      if (/\bt\.Skip(?:Now|f)?\(/.test(line.text)) {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'tests/skipped',
            severity: 'medium',
            verification: 'evidenced',
            verificationNote: 'An added line calls t.Skip; the diff shows it is new in this change.',
            title: `Go test skip added in ${file.path}`,
            description: 'A test now skips itself, so the behavior it covered is no longer verified.',
            location: { file: file.path, startLine: line.line },
            evidenceDescription: `Added line ${line.line}: ${line.text.trim()}`,
            excerpt: line.text.trim(),
          }),
        );
      }
    }
  }
}
