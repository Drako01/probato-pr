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
      r.analysisMs !== undefined && h('div', { class: 'muted' }, `${s.labels.analysisDuration}: ${r.analysisMs.toFixed(0)} ms`),
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

function renderExplanation(s: SummaryState, f: SummaryFinding): HTMLElement {
  const explanation = f.explanation;
  return h('section', { class: 'finding-proof' },
    h('h3', {}, s.labels.findingExplanation),
    h('h4', {}, s.labels.reportedObservation), h('p', {}, explanation.observation), h('p', { class: 'muted' }, explanation.observationNote),
    h('h4', {}, s.labels.linkedEvidence),
    h('ul', {}, ...explanation.evidence.map((reference) => h('li', {},
      h('p', {}, reference.summary),
      reference.locations.length > 0 && h('p', { class: 'muted' }, reference.locations.join(' · ')),
      reference.available && button(s.labels.evidence, () => { post({ type: 'openEvidence', id: reference.id }); }, 'button secondary'),
    ))),
    h('h4', {}, s.labels.linkedChecks),
    explanation.checks.length > 0
      ? h('ul', {}, ...explanation.checks.map((check) => h('li', {}, `${check.label} · ${check.statusLabel}`, h('p', { class: 'muted' }, check.note))))
      : h('p', { class: 'muted' }, s.labels.noLinkedChecks),
    explanation.missingProof.length > 0 && h('h4', {}, s.labels.missingProof),
    explanation.missingProof.length > 0 && h('ul', {}, ...explanation.missingProof.map((missing) => h('li', {}, missing))),
  );
}

function renderComparison(s: SummaryState): HTMLElement {
  const choose = h('select', { 'aria-label': s.labels.chooseComparison, 'data-key': 'comparison:select' });
  choose.append(h('option', { value: '' }, s.labels.chooseComparison));
  for (const candidate of s.comparisonOptions ?? []) choose.append(h('option', { value: candidate.id }, candidate.label));
  choose.value = s.comparison?.previousId ?? '';
  choose.disabled = Boolean(s.busy) || !(s.comparisonOptions?.length);
  choose.addEventListener('change', () => { if (choose.value) post({ type: 'compareReview', id: choose.value }); });
  const comparison = s.comparison;
  const entries = comparison?.comparable ? comparison.entries : [];
  return h('section', { class: 'panel' },
    h('h2', {}, s.labels.comparison), h('p', { class: 'muted' }, s.labels.comparisonEligibility),
    h('div', { class: 'actions' }, choose, comparison && button(s.labels.clearComparison, () => { post({ type: 'clearComparison' }); })),
    comparison?.reason && h('p', { class: 'note' }, comparison.reason),
    comparison?.comparable && h('p', {}, `${s.labels.newFindings}: ${comparison.counts.new} · ${s.labels.persistingFindings}: ${comparison.counts.persisting} · ${s.labels.noLongerObserved}: ${comparison.counts['no-longer-observed']}`),
    h('ul', { class: 'findings' }, ...entries.map((entry) => h('li', { class: 'finding' },
      h('details', {}, h('summary', {}, `${entry.label} · ${entry.title} · ${entry.file}:${entry.line}`),
        h('p', { class: 'note' }, entry.note),
        h('div', { class: 'actions' },
          entry.currentFindingId && button(s.labels.open, () => { if (entry.currentFindingId) post({ type: 'openFinding', id: entry.currentFindingId }); }),
          entry.passedCheckEvidenceId && button(s.labels.evidence, () => { if (entry.passedCheckEvidenceId) post({ type: 'openEvidence', id: entry.passedCheckEvidenceId }); }),
        ),
      ),
    ))),
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
        renderExplanation(s, f),
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
    Boolean(r.reproducibilityLimitations?.length) && h('div', {}, h('h3', {}, s.labels.reproducibilityLimitations), h('ul', {}, ...(r.reproducibilityLimitations ?? []).map((reason) => h('li', {}, reason)))),
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

function renderMutation(s: SummaryState, r: SummaryReview): HTMLElement | undefined {
  const mutation = r.mutation;
  if (!r.hasLocalCheckout && !mutation) return undefined;
  const panel = h('section', { class: 'panel mutation-panel' }, h('h2', {}, s.labels.mutationTitle), h('p', { class: 'muted' }, s.labels.mutationOptional));
  if (r.hasLocalCheckout) panel.append(commandButton(s.labels.mutationRun, 'mutationTesting', 'button secondary'));
  if (!mutation) return panel;
  const axes = h('dl', { class: 'mutation-axes' });
  for (const [label, axis] of [[s.labels.mutationExecution, mutation.execution], [s.labels.mutationVerification, mutation.verification], [s.labels.mutationQuality, mutation.quality], [s.labels.mutationGate, mutation.gate], [s.labels.mutationBaseline, mutation.baseline]] as const) {
    axes.append(h('dt', {}, label), h('dd', {}, axis.label, ' ', h('code', {}, axis.value)));
  }
  panel.append(axes, h('p', { class: 'muted' }, s.labels.mutationMetricHelp));
  const reasons = [...new Set([...mutation.verification.reasons, ...mutation.baseline.reasons, ...mutation.quality.reasons, ...mutation.gate.reasons])];
  if (reasons.length) panel.append(h('ul', {}, ...reasons.map((reason) => h('li', {}, reason))));
  if (mutation.quality.deltaPoints !== undefined) panel.append(h('p', {}, `${s.labels.mutationDelta}: ${mutation.quality.deltaPoints > 0 ? '+' : ''}${mutation.quality.deltaPoints.toLocaleString(document.documentElement.lang, { maximumFractionDigits: 4 })}`));
  for (const run of mutation.runs) {
    const section = h('section', {}, h('h3', {}, run.label), h('code', {}, run.command));
    if (run.score !== undefined) section.append(h('p', {}, `${s.labels.mutationScore}: ${run.score.toLocaleString(document.documentElement.lang, { maximumFractionDigits: 2 })}%`));
    if (run.killedOnlyScore !== undefined) section.append(h('p', { class: 'muted' }, `${s.labels.mutationKilledOnly}: ${run.killedOnlyScore.toLocaleString(document.documentElement.lang, { maximumFractionDigits: 2 })}%`));
    section.append(h('ul', {}, ...run.counts.filter((count) => count.count > 0).map((count) => h('li', {}, `${count.label}: ${count.count}`))));
    const details = h('details', {}, h('summary', {}, s.labels.evidence), h('ul', {}, ...run.context.map((line) => h('li', {}, line))));
    if (run.reportHash) details.append(h('p', { class: 'mutation-hash' }, `${s.labels.mutationReportHash}: ${run.reportHash}`));
    if (run.evidenceId) details.append(button(s.labels.evidence, () => { if (run.evidenceId) post({ type: 'openEvidence', id: run.evidenceId }); }, 'link'));
    section.append(details); panel.append(section);
  }
  if (mutation.mutants.length) {
    const list = h('ul', { class: 'checks' }, ...mutation.mutants.map((mutant) => h('li', {}, h('strong', {}, `${mutant.file}:${mutant.line}`), h('span', {}, mutant.status), h('span', { class: 'muted' }, `${s.labels.mutationRawStatus}: ${mutant.rawStatus}`), h('span', {}, `${s.labels.mutationAttribution}: ${mutant.attribution}`), mutant.detail && h('p', { class: 'muted' }, mutant.detail))));
    panel.append(h('details', {}, h('summary', {}, s.labels.mutationMutants), h('p', { class: 'muted' }, mutation.displayed), list));
  }
  return panel;
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
    renderDelivery(s), renderComparison(s), renderRisk(s, r), renderAi(s, r), renderFindings(s, r), renderChecks(s, r), renderMutation(s, r), renderMore(s)] : [renderEmpty(s)])].filter((n): n is HTMLElement => Boolean(n)));
  if (focused) {
    app.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  state = event.data.state;
  render();
});

post({ type: 'ready' });
