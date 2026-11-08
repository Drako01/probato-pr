// Runs inside the Extension Development Host launched by screenshots.ts. It puts the real extension into each
// state shown in the README and hands over to the launcher, which captures the window through the DevTools protocol.
// Handshake per shot: this side writes `<name>.ready`, the launcher captures and writes `<name>.done`.
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface Shot {
  readonly name: string;
  prepare(): Thenable<unknown>;
}

const THEMES = [
  { suffix: 'dark', theme: 'Default Dark Modern' },
  { suffix: 'light', theme: 'Default Light Modern' },
] as const;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this driver through out/integration/screenshots.js`);
  return value;
}

async function handOver(directory: string, name: string): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  // Webviews render asynchronously after their state message; give them time to settle.
  await delay(2_500);
  const done = path.join(directory, `${name}.done`);
  writeFileSync(path.join(directory, `${name}.ready`), '');
  const deadline = Date.now() + 60_000;
  while (!existsSync(done)) {
    if (Date.now() > deadline) throw new Error(`the launcher did not capture ${name} within 60 s`);
    await delay(200);
  }
}

export async function run(): Promise<void> {
  const directory = requiredEnv('PROBATO_SHOTS_HANDSHAKE');
  const extension = vscode.extensions.getExtension('armotusitio.probato-pr');
  if (!extension) throw new Error('armotusitio.probato-pr is not loaded in the host');
  await extension.activate();
  await vscode.commands.executeCommand('workbench.view.extension.probatoPR');
  await vscode.commands.executeCommand('probatoPR.reviewCurrentChanges');

  const shots: readonly Shot[] = [
    { name: 'home', prepare: () => vscode.commands.executeCommand('probatoPR.openHome', 'home') },
    { name: 'review-summary', prepare: () => vscode.commands.executeCommand('probatoPR.showResults') },
    { name: 'settings', prepare: () => vscode.commands.executeCommand('probatoPR.openHome', 'settings') },
  ];
  for (const { suffix, theme } of THEMES) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    for (const shot of shots) {
      await shot.prepare();
      await handOver(directory, `${shot.name}-${suffix}`);
    }
  }
}
