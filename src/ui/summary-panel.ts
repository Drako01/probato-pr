import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ReviewSession } from '../extension/review-session';
import { SUMMARY_COMMAND_IDS, webviewMessageSchema, type HostMessage, type WebviewMessage } from './summary-protocol';
import { summaryState } from './summary-view-model';

export const SUMMARY_VIEW_TYPE = 'probatoPR.summary';

/**
 * The Review Summary editor panel: risk, guided next step, filterable findings and checks.
 * One panel at a time; it follows the session and survives window reloads through the serializer.
 */
export class SummaryPanel implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private postGeneration = 0;
  private panelSubscriptions: vscode.Disposable[] = [];
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly session: ReviewSession,
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Label of the configured AI provider; undefined when AI is off. */
    private readonly aiLabel: () => string | undefined,
  ) {
    this.subscription = vscode.Disposable.from(
      session.onDidChange(() => {
        this.post();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('probatoPR.ai')) {
          this.post();
        }
      }),
    );
  }

  /** Opens the panel, or reveals it if it is already open. */
  show(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    this.attach(vscode.window.createWebviewPanel(SUMMARY_VIEW_TYPE, vscode.l10n.t('Review Summary'), { viewColumn: column, preserveFocus }, this.options()));
  }

  deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel) {
      panel.dispose(); // a second restored copy would show the same state twice
      return Promise.resolve();
    }
    panel.webview.options = this.options();
    this.attach(panel);
    return Promise.resolve();
  }

  private options(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      enableCommandUris: false,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'mark.svg');
    panel.webview.html = this.html(panel.webview);
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const parsed = webviewMessageSchema.safeParse(raw);
        if (!parsed.success) {
          this.log.warn(`Ignored invalid message from the Review Summary panel: ${parsed.error.message}`);
          return;
        }
        this.handle(parsed.data).catch((error: unknown) => {
          this.log.error(`Review Summary action failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }),
      panel.onDidDispose(() => {
        this.panelSubscriptions.forEach((d) => {
          d.dispose();
        });
        this.panelSubscriptions = [];
        this.panel = undefined;
      }),
    ];
  }

  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post();
        return;
      case 'command':
        await vscode.commands.executeCommand(SUMMARY_COMMAND_IDS[message.command]);
        return;
      case 'openFinding':
        // Code opens next to the summary so both stay visible.
        await vscode.commands.executeCommand('probatoPR.openFinding', message.id, this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One);
        return;
      case 'dismissFinding':
        if (this.session.visibleFindings().some((f) => f.id === message.id)) {
          await this.session.dismiss(message.id);
        }
        return;
      case 'compareReview':
        await this.session.compareWith(message.id);
        return;
      case 'clearComparison':
        this.session.clearComparison();
        return;
      case 'openEvidence':
        await vscode.commands.executeCommand('probatoPR.openEvidence', message.id);
    }
  }

  private post(): void {
    const panel = this.panel;
    if (!panel) return;
    const generation = ++this.postGeneration;
    void this.session.comparisonOptions().then((candidates) => {
      if (this.panel === panel && generation === this.postGeneration) void panel.webview.postMessage({ type: 'state', state: summaryState(this.session, this.aiLabel(), candidates) } satisfies HostMessage);
    }).catch((error: unknown) => {
      this.log.warn(`Comparison history could not be loaded: ${String(error)}`);
      if (this.panel === panel && generation === this.postGeneration) void panel.webview.postMessage({ type: 'state', state: summaryState(this.session, this.aiLabel()) } satisfies HostMessage);
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const title = vscode.l10n.t('Review Summary').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'summary.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'summary.css'));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `img-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>${title}</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}
