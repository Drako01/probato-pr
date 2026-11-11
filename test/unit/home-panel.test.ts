import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import spanishBundle from '../../l10n/bundle.l10n.es.json';
import type { ReviewResult, RiskLevel } from '../../src/core/model';
import { setTranslator } from '../../src/core/i18n';
import type { ReviewSession } from '../../src/extension/review-session';
import { HomePanel, type HomeDependencies, type HomeContext } from '../../src/ui/home-panel';

const host = vi.hoisted(() => ({
  message: undefined as ((raw: unknown) => void) | undefined,
  disposed: undefined as (() => void) | undefined,
  create: vi.fn(), post: vi.fn<(...args: unknown[]) => Promise<boolean>>(), reveal: vi.fn(),
}));
vi.mock('vscode', () => {
  const subscription = () => ({ dispose: () => undefined });
  return {
    l10n: { t: (text: string) => text }, env: { language: 'en' },
    Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.slice(1).join('/') }) }, ViewColumn: { Active: 1 },
    Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose: () => { items.forEach((item) => { item.dispose(); }); } }) },
    workspace: { onDidChangeConfiguration: subscription, onDidChangeWorkspaceFolders: subscription },
    authentication: { onDidChangeSessions: subscription },
    window: { createWebviewPanel: host.create },
  };
});

function fixture(review?: ReviewResult) {
  const panel = {
    webview: { html: '', options: {}, cspSource: 'https://webview.test', asWebviewUri: (uri: { toString(): string }) => ({ toString: () => 'https://webview.test/' + uri.toString() }), postMessage: host.post, onDidReceiveMessage: (listener: (raw: unknown) => void) => { host.message = listener; return { dispose: () => undefined }; } },
    reveal: host.reveal,
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    onDidDispose: (listener: () => void) => { host.disposed = listener; return { dispose: () => undefined }; },
    dispose: () => host.disposed?.(),
  };
  host.create.mockReturnValue(panel);
  const context: HomeContext = { trusted: true, settings: {}, history: [] };
  const deps = {
    loadContext: vi.fn<() => Promise<HomeContext>>().mockResolvedValue(context),
    execute: vi.fn<HomeDependencies['execute']>().mockResolvedValue(undefined),
    saveSetting: vi.fn<HomeDependencies['saveSetting']>().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  const session = { current: review, comparisonOptions: () => Promise.resolve([]), onDidChange: () => ({ dispose: () => undefined }), plan: [], visibleFindings: () => [] } as unknown as ReviewSession;
  const home = new HomePanel(session, {} as vscode.Uri, deps);
  home.show();
  return { home, panel, deps, context };
}

beforeEach(() => { vi.resetAllMocks(); host.message = undefined; host.disposed = undefined; host.post.mockResolvedValue(true); });

afterEach(() => { setTranslator(undefined); });

describe('Home control center host boundary', () => {
  it.each<RiskLevel>(['low', 'medium', 'high', 'critical', 'unknown'])('localizes %s risk in both current review and history', async (risk) => {
    const spanish: Record<string, string> = spanishBundle;
    setTranslator((template) => spanish[template] ?? template);
    const review = { repository: { name: 'repo' }, scope: { label: 'changes' }, risk: { level: risk }, checks: [], createdAt: '2026-11-03' } as unknown as ReviewResult;
    const { home, deps, context } = fixture(review);
    deps.loadContext.mockResolvedValue({ ...context, history: [{ id: 'r', repository: 'repo', scope: 'changes', risk, findings: 0, createdAt: '2026-11-03' }] });
    await home.refresh();
    const message = host.post.mock.calls[0]?.[0] as { state: { review: { risk: string }; history: { risk: string }[] } };
    const expected = { low: 'Bajo', medium: 'Medio', high: 'Alto', critical: 'Crítico', unknown: 'Desconocido' }[risk];
    expect(message.state.review.risk).toBe(expected);
    expect(message.state.history[0]?.risk).toBe(expected);
    home.dispose();
  });

  it('dispatches only allowed actions and validates every editable setting', async () => {
    const { deps, home } = fixture();
    host.message?.({ type: 'action', action: 'workbench.action.terminal.new' });
    host.message?.({ type: 'setting', key: 'verification.checks', value: ['sh'], target: 'user' });
    host.message?.({ type: 'setting', key: 'review.onSave', value: 'true', target: 'user' });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.saveSetting).not.toHaveBeenCalled();
    host.message?.({ type: 'setting', key: 'review.onSave', value: true, target: 'workspace' });
    await vi.waitFor(() => { expect(deps.saveSetting).toHaveBeenCalledExactlyOnceWith('review.onSave', true, 'workspace'); });
    host.message?.({ type: 'action', action: 'reviewCurrentChanges' });
    await vi.waitFor(() => { expect(deps.execute).toHaveBeenCalledExactlyOnceWith('reviewCurrentChanges'); });
    host.message?.({ type: 'action', action: 'publishAnalysis' });
    await vi.waitFor(() => { expect(deps.execute).toHaveBeenLastCalledWith('publishAnalysis'); });
    home.dispose();
  });

  it('exposes the raw risk level next to its localized label so the UI can tone the risk card', async () => {
    const review = { repository: { name: 'repo' }, scope: { label: 'changes' }, risk: { level: 'high' }, checks: [], createdAt: '2026-11-03' } as unknown as ReviewResult;
    const { home } = fixture(review);
    await home.refresh();
    const message = host.post.mock.calls[0]?.[0] as { state: { review: { riskLevel: string } } };
    expect(message.state.review.riskLevel).toBe('high');
    home.dispose();
  });

  it('uses a singleton and restores through the serializer without duplicate panels', async () => {
    const { home, panel } = fixture();
    home.show('settings');
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.reveal).toHaveBeenCalled();
    const dispose = vi.fn();
    await home.deserializeWebviewPanel({ dispose } as unknown as vscode.WebviewPanel);
    expect(dispose).toHaveBeenCalledOnce();
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain("script-src 'nonce-");
    expect(panel.webview.html).toContain('img-src https://webview.test');
    expect(panel.webview.html).toContain('src="https://webview.test/media/logo.svg" alt="Probato PR"');
    expect(panel.webview.html).toContain('--probato-accent:#2ea98f');
    expect(panel.webview.html).not.toContain('P<span>✓');
    expect(panel.webview.html).not.toContain('innerHTML');
    home.dispose();
    home.show();
    expect(host.create).toHaveBeenCalledTimes(2);
    home.dispose();
  });

  it('coalesces refreshes and never posts an async context after disposal', async () => {
    const { home, deps, context } = fixture();
    let release: ((context: HomeContext) => void) | undefined;
    deps.loadContext.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = home.refresh();
    await home.refresh();
    expect(deps.loadContext).toHaveBeenCalledTimes(1);
    release?.(context);
    await first;
    await vi.waitFor(() => { expect(deps.loadContext).toHaveBeenCalledTimes(2); });
    host.post.mockClear();
    deps.loadContext.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = home.refresh();
    home.dispose();
    release?.(context);
    await pending;
    expect(host.post).not.toHaveBeenCalled();
  });

  it('keeps effective, User, and Workspace preferences distinct without writing during refresh', async () => {
    const { home, deps, context } = fixture();
    const settings = { 'review.maxFiles': 100 };
    const userSettings = { 'review.maxFiles': 250 };
    const workspaceSettings = { 'review.maxFiles': 100 };
    deps.loadContext.mockResolvedValue({ ...context, settings, userSettings, workspaceSettings });
    await home.refresh();
    expect(host.post.mock.calls[0]?.[0]).toMatchObject({
      type: 'state', state: { settings, userSettings, workspaceSettings },
    });
    expect(deps.saveSetting).not.toHaveBeenCalled();
    home.dispose();
  });

  it('reports failures without rejecting fire-and-forget event handlers', async () => {
    const { home, deps } = fixture();
    deps.loadContext.mockRejectedValueOnce(new Error('unavailable'));
    await home.refresh();
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(host.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', error: true, loadError: true }));
    deps.execute.mockRejectedValueOnce(new Error('denied'));
    host.message?.({ type: 'action', action: 'connectGitHub' });
    await vi.waitFor(() => { expect(deps.onError).toHaveBeenCalledTimes(2); });
    home.dispose();
  });
});
