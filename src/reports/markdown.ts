import { sanitizeText } from '../core/sanitize';
import { tr } from '../core/i18n';
import { attributionLabel, checkStatusLabel, evidenceRevisionLabel, riskLabel, severityLabel, verificationLabel } from '../core/labels';
import { SEVERITIES, type AiSummary, type Evidence, type ReviewFinding, type ReviewResult } from '../core/model';

// Headings and fixed text follow the active locale like the findings themselves, so a report is never half
// English and half Spanish. Rule ids, commands, paths and hashes stay as they are.

/** Escapes text that is interpolated into Markdown so repository content cannot inject markup or links. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

function location(f: ReviewFinding): string {
  return `${f.location.file}:${f.location.startLine}${f.location.endLine && f.location.endLine !== f.location.startLine ? `-${f.location.endLine}` : ''}`;
}

function code(text: string): string {
  return `\`${text.replace(/[`|]/g, "'")}\``;
}

function evidenceBlock(evidence: Evidence): string {
  if (evidence.kind === 'static-analysis') {
    const head = tr('Static analysis ({0}): {1}', escapeMarkdown(evidence.analyzerId), escapeMarkdown(evidence.description));
    return [`- ${head}`, evidence.excerpt ? `\n${fence(evidence.excerpt)}` : ''].join('');
  }
  const head = tr(
    'Command {0} {1}: **{2}**, exit {3}, {4}s, output sha256 {5}…',
    code(evidence.commandLine),
    evidenceRevisionLabel(evidence),
    checkStatusLabel(evidence.outcome),
    String(evidence.exitCode),
    Math.round(evidence.durationMs / 100) / 10,
    evidence.outputSha256.slice(0, 16),
  );
  return evidence.errorMessage ? `- ${head}\n  ${escapeMarkdown(evidence.errorMessage)}` : `- ${head}`;
}

function riskLine(result: ReviewResult): string {
  return `**${tr('Review risk: {0}', riskLabel(result.risk.level).toUpperCase())}**`;
}

export function renderMarkdown(result: ReviewResult): string {
  result = sanitizeText(result);
  const evidenceById = new Map(result.evidence.map((e) => [e.id, e]));
  const { risk } = result;
  const lines: string[] = [];
  lines.push(`# ${tr('Probato PR review — {0}', escapeMarkdown(result.repository.name))}`);
  lines.push('');
  lines.push(riskLine(result));
  lines.push('');
  const branch = result.repository.branch ? ` ${tr('on {0}', code(result.repository.branch))}` : '';
  lines.push(`- ${tr('Scope: {0}', escapeMarkdown(result.scope.label))}${branch}`);
  if (result.scope.pullRequest) {
    const pr = result.scope.pullRequest;
    lines.push(`- ${tr('Pull request: {0}', escapeMarkdown(`${pr.owner}/${pr.repo}#${pr.number}`))}`);
  }
  lines.push(`- ${tr('Generated: {0} by Probato PR {1}', result.createdAt, result.toolVersion)}`);
  lines.push(`- ${tr('Files: {0} changed (+{1} / -{2}), {3} skipped', result.stats.filesChanged, result.stats.additions, result.stats.deletions, result.stats.filesSkipped)}`);
  lines.push('');
  const headers = [
    verificationLabel('confirmed'),
    verificationLabel('evidenced'),
    verificationLabel('suspected'),
    verificationLabel('not-verified'),
    tr('Checks passed'),
    tr('Checks failed'),
    tr('Checks not run'),
    tr('Regressions'),
  ];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`|${'---|'.repeat(headers.length)}`);
  const v = risk.counts.byVerification;
  const c = risk.counts.checks;
  lines.push(`| ${v.confirmed} | ${v.evidenced} | ${v.suspected} | ${v['not-verified']} | ${c.passed} | ${c.failed} | ${c.notRun} | ${risk.counts.regressions} |`);
  lines.push('');
  lines.push(`## ${tr('Why this risk level')}`);
  lines.push('');
  risk.reasons.forEach((r) => lines.push(`- ${escapeMarkdown(r)}`));
  if (risk.limitations.length > 0) {
    lines.push('');
    lines.push(`## ${tr('Limitations')}`);
    lines.push('');
    risk.limitations.forEach((l) => lines.push(`- ${escapeMarkdown(l)}`));
  }

  lines.push('');
  lines.push(`## ${tr('Verification')}`);
  lines.push('');
  if (result.checks.length === 0) {
    lines.push(tr('No checks were executed.'));
  } else {
    lines.push(`| ${tr('Check')} | ${tr('Result')} | ${tr('Attribution')} | ${tr('Note')} |`);
    lines.push('|---|---|---|---|');
    for (const check of result.checks) {
      lines.push(`| ${code(check.commandLine)} | ${checkStatusLabel(check.status)} | ${attributionLabel(check.attribution) ?? '—'} | ${escapeMarkdown(check.attributionNote)} |`);
    }
  }

  lines.push('');
  lines.push(`## ${tr('Findings ({0})', result.findings.length)}`);
  if (result.findings.length === 0) {
    lines.push('');
    lines.push(tr('No findings.'));
  }
  for (const finding of result.findings) {
    lines.push('');
    lines.push(`### [${severityLabel(finding.severity).toUpperCase()}] ${escapeMarkdown(finding.title)}`);
    lines.push('');
    lines.push(`- ${tr('Location: {0}', code(location(finding)))}`);
    lines.push(`- ${tr('Verification: {0}', `**${verificationLabel(finding.verification)}**`)} — ${escapeMarkdown(finding.verificationNote)}`);
    const attribution = attributionLabel(finding.attribution);
    if (attribution) {
      lines.push(`- ${tr('Attribution: {0}', attribution)}`);
    }
    lines.push(`- ${tr('Rule: {0} ({1})', code(finding.ruleId), finding.origin)}`);
    lines.push('');
    lines.push(escapeMarkdown(finding.description));
    if (finding.suggestedFix) {
      lines.push('');
      lines.push(`**${tr('Suggested fix:')}** ${escapeMarkdown(finding.suggestedFix)}`);
    }
    const evidence = finding.evidence.map((ref) => evidenceById.get(ref.evidenceId)).filter((e): e is Evidence => e !== undefined);
    if (evidence.length > 0) {
      lines.push('');
      lines.push(`**${tr('Evidence')}**`);
      lines.push('');
      evidence.forEach((e) => lines.push(evidenceBlock(e)));
    }
  }

  if (result.aiSummary) {
    lines.push('');
    lines.push(`## ${tr('AI walkthrough ({0})', escapeMarkdown(result.aiSummary.author))}`);
    lines.push('');
    lines.push(...walkthrough(result.aiSummary));
  }

  if (result.aiRuns.length > 0) {
    lines.push('');
    lines.push(`## ${tr('AI review')}`);
    for (const run of result.aiRuns) {
      lines.push('');
      lines.push(
        `- ${tr(
          '{0} ({1}) at {2}: {3} finding(s) accepted, {4} rejected. Files shared: {5}.',
          escapeMarkdown(run.providerId),
          escapeMarkdown(run.model),
          run.startedAt,
          run.accepted,
          run.rejected,
          run.filesShared.length,
        )}`,
      );
      run.rejectionReasons.slice(0, 10).forEach((r) => lines.push(`  - ${tr('Rejected: {0}', escapeMarkdown(r))}`));
    }
  }

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push(`## ${tr('Files not analyzed')}`);
    lines.push('');
    result.skipped.slice(0, 200).forEach((s) => lines.push(`- ${code(s.path)} — ${escapeMarkdown(s.reason)}`));
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_${tr('Generated by Probato PR (ArmoTuSitio). AI and static findings are not proof; only executed checks count as verification.')}_`);
  lines.push('');
  return lines.join('\n');
}

const DESCRIPTION_FINDINGS = 10;

function walkthrough(summary: AiSummary): string[] {
  const lines = [escapeMarkdown(summary.overview)];
  if (summary.changes.length > 0) {
    lines.push('', ...summary.changes.map((c) => `- ${code(c.file)}: ${escapeMarkdown(c.summary)}`));
  }
  if (summary.reviewFocus.length > 0) {
    lines.push('', `**${tr('Where to look first')}**`, '', ...summary.reviewFocus.map((f) => `- ${escapeMarkdown(f)}`));
  }
  return lines;
}

/**
 * Compact Markdown for a pull request description: the AI walkthrough when there is one, then what
 * Probato PR verified. Works without AI. Repository-controlled text is escaped like the full report.
 */
export function renderPullRequestDescription(result: ReviewResult): string {
  result = sanitizeText(result);
  const { risk } = result;
  const v = risk.counts.byVerification;
  const lines: string[] = [];
  if (result.aiSummary) {
    lines.push(`## ${tr('Summary')}`, '', ...walkthrough(result.aiSummary), '');
  }
  lines.push(`## ${tr('Verification (Probato PR)')}`, '');
  lines.push(`${riskLine(result)} · ${tr('{0} file(s), +{1} / -{2}', result.stats.filesChanged, result.stats.additions, result.stats.deletions)}`);
  lines.push('');
  lines.push(tr('Findings: {0} confirmed · {1} evidenced · {2} suspected · {3} not verified', v.confirmed, v.evidenced, v.suspected, v['not-verified']));
  if (result.checks.length > 0) {
    lines.push('');
    result.checks.forEach((c) => {
      const attribution = attributionLabel(c.attribution);
      lines.push(`- ${code(c.commandLine)}: ${checkStatusLabel(c.status)}${attribution ? ` (${attribution})` : ''}`);
    });
  } else {
    lines.push('', tr('No project checks were executed.'));
  }
  const top = [...result.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)).slice(0, DESCRIPTION_FINDINGS);
  if (top.length > 0) {
    lines.push('', `### ${tr('Findings')}`, '');
    top.forEach((f) => lines.push(`- **${severityLabel(f.severity).toUpperCase()}** · ${verificationLabel(f.verification)} · ${escapeMarkdown(f.title)} (${code(location(f))})`));
    if (result.findings.length > top.length) {
      lines.push(`- ${tr('…and {0} more in the full report.', result.findings.length - top.length)}`);
    }
  }
  lines.push('', `<sub>${tr('Generated by Probato PR. Only executed checks count as proof; AI and static findings are not.')}</sub>`, '');
  return lines.join('\n');
}
