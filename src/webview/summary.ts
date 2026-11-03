// Review Summary webview. Renders host-provided state with DOM APIs only (textContent, never innerHTML),
// so repository-derived text cannot inject markup. All actions are posted to the host, which validates them.
import type { HostMessage, SummaryCommand, SummaryFinding, SummaryReview, SummaryState, WebviewMessage } from '../ui/summary-protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: ViewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface ViewState {
  readonly severity: string;
  readonly groupBy: 'severity' | 'file';
  readonly expanded: readonly string[];
}

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

function readViewState(): ViewState {
  const saved = vscode.getState() as Partial<ViewState> | undefined;
  return {
    severity: typeof saved?.severity === 'string' ? saved.severity : 'all',
    groupBy: saved?.groupBy === 'file' ? 'file' : 'severity',
    expanded: Array.isArray(saved?.expanded) ? saved.expanded.filter((e): e is string => typeof e === 'string') : [],
  };
}

let view = readViewState();
let state: SummaryState | undefined;

function setView(patch: Partial<ViewState>): void {
  view = { ...view, ...patch };
  vscode.setState(view);
  render();
}

type Child = Node | string | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== false && child !== undefined) {
      el.append(child);
    }
  }
  return el;
}

function button(label: string, onClick: () => void, className = 'button secondary', attrs: Record<string, string> = {}): HTMLButtonElement {
  const el = h('button', { type: 'button', class: className, ...attrs }, label);
  el.addEventListener('click', onClick);
  return el;
}

const post = (message: WebviewMessage): void => {
  vscode.postMessage(message);
};

/** A button that asks the host to run one of the allowlisted Probato PR commands. */
const commandButton = (label: string, command: SummaryCommand, className = 'button secondary'): HTMLButtonElement =>
  button(label, () => {
    post({ type: 'command', command });
  }, className);

function renderEmpty(s: SummaryState): HTMLElement {
  return h(
    'section',
    { class: 'empty' },
    h('h1', {}, s.labels.noReview),
    h('p', {}, s.labels.noReviewHint),
    h(
      'div',
      { class: 'actions' },
      commandButton(s.labels.reviewCurrent, 'reviewCurrentChanges', 'button'),
      commandButton(s.labels.reviewBranch, 'reviewBranch'),
    ),
    renderDelivery(s),
  );
}

function renderDelivery(s: SummaryState): HTMLElement {
  return h('section', { class: 'panel' }, h('h2', {}, s.labels.delivery), h('p', { class: 'muted' }, s.labels.deliveryHint),
    h('div', { class: 'actions' },
      commandButton(s.labels.localGit, 'localGit'),
      commandButton(s.labels.delivery, 'delivery', 'button'),
      ...(s.review ? [commandButton(s.labels.publishPullRequest, 'publishPullRequest'), commandButton(s.labels.publishReview, 'publishReview'), commandButton(s.labels.importSarif, 'importSarif')] : []),
      commandButton(s.labels.pullRequestStatus, 'pullRequestStatus'), commandButton(s.labels.mergePullRequest, 'mergePullRequest')));
}

function renderHeader(s: SummaryState, r: SummaryReview): HTMLElement {
  return h(
    'header',
    { class: `hero risk-${r.risk.level}` },
    h(
      'div',
      { class: 'hero-main' },
      h('div', { class: 'eyebrow' }, s.labels.riskTitle),
      h('div', { class: 'risk-level' }, r.risk.label.toUpperCase()),
      h('div', { class: 'repo' }, h('strong', {}, r.title), r.subtitle ? ` · ${r.subtitle}` : ''),
      h('div', { class: 'muted' }, r.stats),
    ),
    h(
      'div',
      { class: 'counts' },
      ...r.severityCounts.map((c) =>
        h('div', { class: `count sev-${c.severity}${c.count === 0 ? ' zero' : ''}` }, h('span', { class: 'count-value' }, String(c.count)), h('span', { class: 'count-label' }, c.label)),
      ),
    ),
  );
}

function renderSteps(r: SummaryReview): HTMLElement {
  return h(
    'ol',
    { class: 'steps' },
    ...r.steps.map((step, index) =>
      h(
        'li',
        { class: `step ${step.state}${step.id === r.next ? ' next' : ''}` },
        h('span', { class: 'step-marker', 'aria-hidden': 'true' }, step.state === 'done' ? '✓' : String(index + 1)),
        h(
          'div',
          { class: 'step-body' },
          h('div', { class: 'step-title' }, step.title),
          h('div', { class: 'step-detail' }, step.detail),
          step.action && commandButton(step.action.label, step.action.command, step.id === r.next ? 'button' : 'button secondary'),
        ),
      ),
    ),
  );
}

function renderAi(s: SummaryState, r: SummaryReview): HTMLElement {
  const { ai } = r;
  if (ai.summary) {
    const summary = ai.summary;
    return h(
      'section',
      { class: 'panel ai' },
      h('div', { class: 'panel-head' }, h('h2', {}, s.labels.aiTitle), h('span', { class: 'muted' }, summary.author)),
      h('p', {}, summary.overview),
      summary.changes.length > 0 && h('ul', { class: 'ai-changes' }, ...summary.changes.map((c) => h('li', {}, h('code', {}, c.file), ` ${c.summary}`))),
      summary.reviewFocus.length > 0 && h('h3', {}, s.labels.aiWhereToLook),
      summary.reviewFocus.length > 0 && h('ul', {}, ...summary.reviewFocus.map((f) => h('li', {}, f))),
      h('div', { class: 'actions' }, commandButton(s.labels.copyDescription, 'copyPullRequestDescription', 'button'), commandButton(s.labels.aiRunAgain, 'aiReview'), commandButton(s.labels.aiChange, 'connectAi', 'link')),
    );
  }
  const connected = ai.provider !== undefined;
  return h(
    'section',
    { class: 'panel ai' },
    h('div', { class: 'panel-head' }, h('h2', {}, s.labels.aiTitle), connected && h('span', { class: 'muted' }, ai.provider)),
    h('p', { class: 'muted' }, connected ? s.labels.aiReadyHint : s.labels.aiConnectHint),
    h(
      'div',
      { class: 'actions' },
      connected ? commandButton(s.labels.aiRun, 'aiReview', 'button') : commandButton(s.labels.aiConnect, 'connectAi', 'button'),
      connected && commandButton(s.labels.aiChange, 'connectAi', 'link'),
    ),
  );
}

function renderRisk(s: SummaryState, r: SummaryReview): HTMLElement | undefined {
  if (r.risk.reasons.length === 0 && r.risk.limitations.length === 0) {
    return undefined;
  }
  return h(
    'section',
    { class: 'panel' },
    r.risk.reasons.length > 0 && h('h2', {}, s.labels.whyRisk),
    r.risk.reasons.length > 0 && h('ul', { class: 'reasons' }, ...r.risk.reasons.map((reason) => h('li', {}, reason))),
    r.risk.limitations.length > 0 && h('h3', {}, s.labels.limitations),
    r.risk.limitations.length > 0 && h('ul', { class: 'limitations' }, ...r.risk.limitations.map((l) => h('li', {}, l))),
  );
}

function renderFinding(s: SummaryState, f: SummaryFinding): HTMLElement {
  const open = view.expanded.includes(f.id);
  const toggle = (): void => {
    setView({ expanded: open ? view.expanded.filter((id) => id !== f.id) : [...view.expanded, f.id] });
  };
  const summary = h(
    'button',
    { type: 'button', class: 'finding-head', 'aria-expanded': String(open), 'data-key': `finding:${f.id}` },
    h('span', { class: `sev-dot sev-${f.severity}`, title: f.severityLabel }),
    h('span', { class: 'finding-title' }, f.title),
    h('span', { class: `chip ver-${f.verification}` }, f.verificationLabel),
    h('span', { class: 'location' }, `${f.file}:${f.line}`),
  );
  summary.addEventListener('click', toggle);
  return h(
    'li',
    { class: `finding${open ? ' open' : ''}` },
    summary,
    open &&
      h(
        'div',
        { class: 'finding-body' },
        h('p', {}, f.description),
        h('p', { class: 'note' }, h('strong', {}, `${s.labels.whyStatus}: `), f.note),
        f.fix && h('p', { class: 'fix' }, h('strong', {}, `${s.labels.suggestedFix}: `), f.fix),
        h('div', { class: 'meta' }, [f.severityLabel, f.attribution, f.ruleId].filter(Boolean).join(' · ')),
        h(
          'div',
          { class: 'actions' },
          button(s.labels.open, () => {
            post({ type: 'openFinding', id: f.id });
          }, 'button'),
          button(s.labels.dismiss, () => {
            post({ type: 'dismissFinding', id: f.id });
          }),
        ),
      ),
  );
}

function groups(r: SummaryReview, findings: readonly SummaryFinding[]): { key: string; label: string; items: readonly SummaryFinding[] }[] {
  if (view.groupBy === 'file') {
    const files = [...new Set(findings.map((f) => f.file))].sort((a, b) => a.localeCompare(b));
    return files.map((file) => ({ key: file, label: file, items: findings.filter((f) => f.file === file) }));
  }
  return r.severityCounts.map((c) => ({ key: c.severity, label: c.label, items: findings.filter((f) => f.severity === c.severity) })).filter((g) => g.items.length > 0);
}

function renderFindings(s: SummaryState, r: SummaryReview): HTMLElement {
  const severity = r.severityCounts.some((c) => c.severity === view.severity && c.count > 0) ? view.severity : 'all';
  const findings = severity === 'all' ? r.findings : r.findings.filter((f) => f.severity === severity);
  const chip = (key: string, label: string, count: number): HTMLButtonElement =>
    button(`${label} ${count}`, () => {
      setView({ severity: key });
    }, `filter${severity === key ? ' active' : ''}${key === 'all' ? '' : ` sev-${key}`}`, { 'aria-pressed': String(severity === key), 'data-key': `filter:${key}` });

  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, `${s.labels.findings} (${r.findings.length})`),
      h(
        'div',
        { class: 'segmented', role: 'group' },
        button(s.labels.groupBySeverity, () => {
          setView({ groupBy: 'severity' });
        }, `segment${view.groupBy === 'severity' ? ' active' : ''}`, { 'aria-pressed': String(view.groupBy === 'severity'), 'data-key': 'group:severity' }),
        button(s.labels.groupByFile, () => {
          setView({ groupBy: 'file' });
        }, `segment${view.groupBy === 'file' ? ' active' : ''}`, { 'aria-pressed': String(view.groupBy === 'file'), 'data-key': 'group:file' }),
      ),
    ),
    r.findings.length > 0 &&
      h('div', { class: 'filters', role: 'group' }, chip('all', s.labels.all, r.findings.length), ...r.severityCounts.filter((c) => c.count > 0).map((c) => chip(c.severity, c.label, c.count))),
    r.findings.length === 0
      ? h('p', { class: 'muted' }, s.labels.noFindings)
      : h(
          'div',
          { class: 'groups' },
          ...groups(r, findings).map((g) => h('div', { class: 'group' }, h('h3', { class: 'group-title' }, `${g.label} · ${g.items.length}`), h('ul', { class: 'findings' }, ...g.items.map((f) => renderFinding(s, f))))),
        ),
    h('p', { class: 'legend' }, ...r.verificationCounts.map((v) => h('span', { class: `chip ver-${v.status}`, title: v.hint }, `${v.label} ${v.count}`)), h('span', { class: 'muted' }, s.labels.statusLegend)),
    r.dismissed > 0 &&
      commandButton(`${s.labels.restoreDismissed} (${r.dismissed})`, 'restoreDismissed', 'link'),
  );
}

function renderChecks(s: SummaryState, r: SummaryReview): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, s.labels.checks),
    r.checks.length === 0
      ? h('p', { class: 'muted' }, s.labels.noChecks)
      : h(
          'ul',
          { class: 'checks' },
          ...r.checks.map((c) =>
            h(
              'li',
              { class: `check status-${c.status}` },
              h('span', { class: 'check-label' }, c.label),
              h('span', { class: 'check-status' }, c.statusLabel),
              h('span', { class: 'check-note muted' }, c.note),
              c.evidenceId &&
                button(s.labels.evidence, () => {
                  if (c.evidenceId) {
                    post({ type: 'openEvidence', id: c.evidenceId });
                  }
                }, 'link'),
            ),
          ),
        ),
  );
}

function renderMore(s: SummaryState): HTMLElement {
  return h(
    'footer',
    { class: 'more' },
    commandButton(s.labels.copyDescription, 'copyPullRequestDescription', 'link'),
    commandButton(s.labels.exportReport, 'exportReport', 'link'),
    commandButton(s.labels.markdown, 'openMarkdownReport', 'link'),
    h('span', { class: 'muted' }, `${s.labels.reviewAgain}:`),
    commandButton(s.labels.reviewCurrent, 'reviewCurrentChanges', 'link'),
    commandButton(s.labels.staged, 'reviewStagedChanges', 'link'),
    commandButton(s.labels.reviewBranch, 'reviewBranch', 'link'),
    commandButton(s.labels.commit, 'reviewCommit', 'link'),
    commandButton(s.labels.pullRequest, 'reviewPullRequest', 'link'),
  );
}

function render(): void {
  if (!app || !state) {
    return;
  }
  const s = state;
  const busy =
    s.busy &&
    h('div', { class: 'busy', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, `${s.busy}…`), commandButton(s.labels.cancel, 'cancel', 'link'));
  const r = s.review;
  // Re-rendering replaces the DOM; keep keyboard focus on the same control.
  const focused = document.activeElement?.getAttribute('data-key');
  app.replaceChildren(...[busy, ...(r ? [renderHeader(s, r), renderSteps(r),
    renderDelivery(s), renderRisk(s, r), renderAi(s, r), renderFindings(s, r), renderChecks(s, r), renderMore(s)] : [renderEmpty(s)])].filter((n): n is HTMLElement => Boolean(n)));
  if (focused) {
    app.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  state = event.data.state;
  render();
});

post({ type: 'ready' });
