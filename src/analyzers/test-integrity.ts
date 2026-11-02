import * as ts from 'typescript';
import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { OutputCollector, staticFinding } from '../core/finding-factory';
import { msg, tr } from '../core/i18n';
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
  get description(): string {
    return tr('Tests removed, skipped, focused or weakened by the change');
  }

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
            verificationNote: msg('The base version of the file contained {0} test case(s); the file is deleted in this change.', base.length),
            title: msg('Test file deleted: {0}', file.path),
            description: msg(
              'Deleting {0} removes {1} test case(s). If the covered behavior still exists, it is no longer protected.',
              file.path,
              base.length,
            ),
            location: { file: file.path, startLine: 1 },
            evidenceDescription: msg(
              'Base revision had {0} test case(s): {1}{2}',
              base.length,
              base.slice(0, 5).map((c) => c.title).join('; '),
              base.length > 5 ? '…' : '',
            ),
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
          verificationNote: msg('Test count dropped from {0} to {1} (AST comparison of base and head).', base.length, head.length),
          title: msg('{0} test case(s) removed in {1}', removed.length, file.path),
          description: msg('Removed: {0}.', removed.map((c) => `"${c.title}"`).join(', ')),
          location: { file: file.path, startLine: head[0]?.line ?? 1 },
          evidenceDescription: msg('Test cases present in base but not in head: {0}', removed.map((c) => c.title).join('; ')),
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
            verificationNote: msg('The AST shows a focus modifier (.only/fit/fdescribe) that was not present in the base revision.'),
            title: msg('Focused test added: "{0}"', testCase.title),
            description: msg('A focused test makes the runner skip every other test in the file or suite, so CI can pass while most tests never run.'),
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: msg('Line {0} declares a focused test.', testCase.line),
            suggestedFix: msg('Remove the .only / f-prefix before merging.'),
          }),
        );
      } else if (testCase.mode === 'skipped' && before && before.mode !== 'skipped') {
        out.add(
          staticFinding({
            analyzerId: ID,
            ruleId: 'tests/skipped',
            severity: 'medium',
            verification: 'evidenced',
            verificationNote: msg('The test ran in the base revision and is skipped in head (AST comparison).'),
            title: msg('Test disabled: "{0}"', testCase.title),
            description: msg('An existing test was disabled by this change, so the behavior it covered is no longer verified.'),
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: msg('Line {0}: test skipped (was active in base).', testCase.line),
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
            verificationNote: msg(
              'Assertion calls in this test went from {0} to {1} (AST count of expect/assert calls).',
              before.assertions,
              testCase.assertions,
            ),
            title: none ? msg('Test no longer asserts anything: "{0}"', testCase.title) : msg('Fewer assertions in "{0}"', testCase.title),
            description: none
              ? msg('The test still runs but cannot fail on wrong results, which makes it pass unconditionally.')
              : msg('The test checks less than before; confirm the removed assertions were obsolete.'),
            location: { file: file.path, startLine: testCase.line },
            evidenceDescription: msg('Assertions: base {0}, head {1}.', before.assertions, testCase.assertions),
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
          verificationNote: msg('Line-level diff comparison: Test function declarations were deleted and not re-added.'),
          title: msg('{0} Go test(s) removed in {1}', reallyRemoved.length, file.path),
          description: msg('Removed: {0}.', reallyRemoved.join(', ')),
          location: { file: file.path, startLine: 1 },
          evidenceDescription: msg('Deleted declarations: {0}', reallyRemoved.join(', ')),
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
            verificationNote: msg('An added line calls t.Skip; the diff shows it is new in this change.'),
            title: msg('Go test skip added in {0}', file.path),
            description: msg('A test now skips itself, so the behavior it covered is no longer verified.'),
            location: { file: file.path, startLine: line.line },
            evidenceDescription: msg('Added line {0}: {1}', line.line, line.text.trim()),
            excerpt: line.text.trim(),
          }),
        );
      }
    }
  }
}
