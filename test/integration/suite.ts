// Runs inside the Extension Development Host; PROBATO_SCENARIO selects the tests for the opened workspace.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';

interface Finding {
  id: string;
  ruleId: string;
  verification: string;
  location: { file: string; startLine: number };
}
interface ProbatoApi {
  currentReview(): { findings: Finding[]; repository: { root: string }; risk: { level: string } } | undefined;
}

const EXTENSION_ID = 'armotusitio.probato-pr';

async function api(): Promise<ProbatoApi> {
  const extension = vscode.extensions.getExtension<ProbatoApi>(EXTENSION_ID);
  assert.ok(extension, 'extension is installed in the host');
  return extension.activate();
}

function sameFile(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function singleRepoTests(): void {
  suite('single trusted repository', () => {
    test('activates and registers every contributed command', async () => {
      await api();
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      const commands = await vscode.commands.getCommands(true);
      const manifest = extension?.packageJSON as { contributes: { commands: { command: string }[] } };
      for (const { command } of manifest.contributes.commands) {
        assert.ok(commands.includes(command), `command ${command} is registered`);
      }
    });

    test('Home opens as one persistent editor tab', async () => {
      await api();
      const homeTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('probatoPR.home'));
      await vscode.commands.executeCommand('probatoPR.openHome');
      if (!homeTabs().length) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); reject(new Error('Home tab did not appear')); }, 10_000);
        const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
          if (homeTabs().length) { clearTimeout(timer); listener.dispose(); resolve(); }
        });
      });
      await vscode.commands.executeCommand('probatoPR.openHome');
      assert.equal(homeTabs().length, 1, 'reopening Home reveals the existing panel');
    });

    test('Review Current Changes finds the broken consumer and publishes a diagnostic', async () => {
      const probato = await api();
      await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges');
      const review = probato.currentReview();
      assert.ok(review, 'a review result exists');
      const finding = review.findings.find((f) => f.ruleId === 'contracts/export-removed');
      assert.ok(finding, `contract finding present, got ${JSON.stringify(review.findings.map((f) => f.ruleId))}`);
      assert.equal(finding.location.file, 'src/profile.ts');
      assert.equal(finding.verification, 'evidenced');
      const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(process.env.PROBATO_FIXTURE ?? '', 'src', 'profile.ts')));
      const ours = diagnostics.filter((d) => d.source === 'Probato PR');
      assert.equal(ours.length, 1);
      assert.equal(ours[0]?.range.start.line, 0);
    });

    test('opening a finding navigates to its file and line', async () => {
      const probato = await api();
      const finding = probato.currentReview()?.findings.find((f) => f.ruleId === 'contracts/export-removed');
      assert.ok(finding);
      await vscode.commands.executeCommand('probatoPR.openFinding', finding.id);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'an editor is open');
      assert.ok(sameFile(editor.document.uri.fsPath, path.join(process.env.PROBATO_FIXTURE ?? '', 'src', 'profile.ts')));
      assert.equal(editor.selection.active.line, finding.location.startLine - 1);
    });

    test('a review opens the Review Summary panel and the view commands work', async () => {
      const summaryTabs = (): vscode.Tab[] =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('probatoPR.summary'));
      assert.equal(summaryTabs().length, 1, 'the summary panel opened after the review');
      await vscode.commands.executeCommand('probatoPR.showResults');
      assert.equal(summaryTabs().length, 1, 'showing results reveals the same panel instead of opening another');
      await vscode.commands.executeCommand('probatoPR.groupFindingsByFile');
      await vscode.commands.executeCommand('probatoPR.groupFindingsBySeverity');
    });

    test('Copy PR Description puts the verification summary on the clipboard (no AI configured)', async () => {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('probatoPR.copyPullRequestDescription');
      const text = await vscode.env.clipboard.readText();
      assert.match(text, /## Verification \(Probato PR\)/);
      assert.match(text, /Review risk: /);
      assert.doesNotMatch(text, /## Summary/, 'no AI walkthrough without an AI run');
    });

    test('a workspace cannot redirect the AI API key: the base URL is a user-level setting', async () => {
      const config = vscode.workspace.getConfiguration('probatoPR');
      await assert.rejects(Promise.resolve(config.update('ai.openaiCompatible.baseUrl', 'https://evil.example/v1', vscode.ConfigurationTarget.Workspace)));
      assert.equal(config.inspect('ai.openaiCompatible.baseUrl')?.workspaceValue, undefined);
    });

    test('the Markdown report renders through the virtual document provider', async () => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'probato-report', path: '/Probato PR Review.md' }));
      assert.match(document.getText(), /# Probato PR review/);
      assert.match(document.getText(), /contracts\/export-removed/);
    });
  });
}

function restrictedTests(): void {
  suite('Restricted Mode (untrusted workspace)', () => {
    test('the workspace is untrusted and the extension still activates', async () => {
      assert.equal(vscode.workspace.isTrusted, false);
      await api();
    });

    test('reviews refuse to run Git or tools until the workspace is trusted', async () => {
      const probato = await api();
      await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges');
      await vscode.commands.executeCommand('probatoPR.verify');
      assert.equal(probato.currentReview(), undefined, 'no review was produced');
      const diagnostics = vscode.languages.getDiagnostics().flatMap(([, list]) => list).filter((d) => d.source === 'Probato PR');
      assert.equal(diagnostics.length, 0);
    });
  });
}

function multiRootTests(): void {
  suite('multi-root workspace', () => {
    test('opens three folders (two repositories and a plain folder)', () => {
      assert.equal(vscode.workspace.workspaceFolders?.length, 3);
    });

    test('a review targeted at a clean repository produces no review', async () => {
      const probato = await api();
      await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges', vscode.Uri.file(process.env.PROBATO_REPO_B ?? ''));
      assert.equal(probato.currentReview(), undefined);
    });

    test('a review targeted at a folder that is not a repository is refused', async () => {
      const probato = await api();
      await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges', vscode.Uri.file(process.env.PROBATO_PLAIN ?? ''));
      assert.equal(probato.currentReview(), undefined);
    });

    test('a review targeted at the changed repository (as passed by the SCM view) reviews only that repository', async () => {
      const probato = await api();
      await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges', { rootUri: vscode.Uri.file(process.env.PROBATO_REPO_A ?? '') });
      const review = probato.currentReview();
      assert.ok(review);
      assert.ok(sameFile(review.repository.root, process.env.PROBATO_REPO_A ?? ''));
      assert.ok(review.findings.some((f) => f.ruleId === 'contracts/export-removed'));
    });
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 60_000, color: false });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  switch (process.env.PROBATO_SCENARIO) {
    case 'restricted':
      restrictedTests();
      break;
    case 'multiroot':
      multiRootTests();
      break;
    default:
      singleRepoTests();
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}
