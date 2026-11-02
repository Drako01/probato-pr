import { SEVERITIES, type AiSummary, type CheckResult, type Evidence, type ReviewFinding, type ReviewResult } from '../core/model';

const VERIFICATION_LABEL: Readonly<Record<ReviewFinding['verification'], string>> = {
  confirmed: 'Confirmed',
  evidenced: 'Evidenced',
  suspected: 'Suspected',
  'not-verified': 'Not verified',
};

const CHECK_ICON: Readonly<Record<CheckResult['status'], string>> = {
  passed: 'PASS',
  failed: 'FAIL',
  'timed-out': 'TIMEOUT',
  cancelled: 'CANCELLED',
  error: 'ERROR',
  pending: 'NOT RUN',
};

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

function evidenceBlock(evidence: Evidence): string {
  if (evidence.kind === 'static-analysis') {
    return [`- Static analysis (${escapeMarkdown(evidence.analyzerId)}): ${escapeMarkdown(evidence.description)}`, evidence.excerpt ? `\n${fence(evidence.excerpt)}` : ''].join('');
  }
  const head = `- Command \`${evidence.commandLine.replace(/`/g, "'")}\` on ${evidence.revision} ${evidence.commitSha ? evidence.commitSha.slice(0, 10) : ''}${evidence.dirty ? ' (with uncommitted changes)' : ''}: **${evidence.outcome}**, exit ${String(evidence.exitCode)}, ${Math.round(evidence.durationMs / 100) / 10}s, output sha256 ${evidence.outputSha256.slice(0, 16)}…`;
  return evidence.errorMessage ? `${head}\n  ${escapeMarkdown(evidence.errorMessage)}` : head;
}

export function renderMarkdown(result: ReviewResult): string {
  const evidenceById = new Map(result.evidence.map((e) => [e.id, e]));
  const { risk } = result;
  const lines: string[] = [];
  lines.push(`# Probato PR review — ${escapeMarkdown(result.repository.name)}`);
  lines.push('');
  lines.push(`**Review risk: ${risk.level.toUpperCase()}**`);
  lines.push('');
  lines.push(`- Scope: ${escapeMarkdown(result.scope.label)}${result.repository.branch ? ` on \`${result.repository.branch.replace(/`/g, '')}\`` : ''}`);
  if (result.scope.pullRequest) {
    lines.push(`- Pull request: ${escapeMarkdown(`${result.scope.pullRequest.owner}/${result.scope.pullRequest.repo}#${result.scope.pullRequest.number}`)}`);
  }
  lines.push(`- Generated: ${result.createdAt} by Probato PR ${result.toolVersion}`);
  lines.push(`- Files: ${result.stats.filesChanged} changed (+${result.stats.additions} / -${result.stats.deletions}), ${result.stats.filesSkipped} skipped`);
  lines.push('');
  lines.push('| Confirmed | Evidenced | Suspected | Not verified | Checks passed | Checks failed | Checks not run | Regressions |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const v = risk.counts.byVerification;
  const c = risk.counts.checks;
  lines.push(`| ${v.confirmed} | ${v.evidenced} | ${v.suspected} | ${v['not-verified']} | ${c.passed} | ${c.failed} | ${c.notRun} | ${risk.counts.regressions} |`);
  lines.push('');
  lines.push('## Why this risk level');
  lines.push('');
  risk.reasons.forEach((r) => lines.push(`- ${escapeMarkdown(r)}`));
  if (risk.limitations.length > 0) {
    lines.push('');
    lines.push('## Limitations');
    lines.push('');
    risk.limitations.forEach((l) => lines.push(`- ${escapeMarkdown(l)}`));
  }

  lines.push('');
  lines.push('## Verification');
  lines.push('');
  if (result.checks.length === 0) {
    lines.push('No checks were executed.');
  } else {
    lines.push('| Check | Result | Attribution | Note |');
    lines.push('|---|---|---|---|');
    for (const check of result.checks) {
      lines.push(`| \`${check.commandLine.replace(/[`|]/g, "'")}\` | ${CHECK_ICON[check.status]} | ${check.attribution} | ${escapeMarkdown(check.attributionNote)} |`);
    }
  }

  lines.push('');
  lines.push(`## Findings (${result.findings.length})`);
  if (result.findings.length === 0) {
    lines.push('');
    lines.push('No findings.');
  }
  for (const finding of result.findings) {
    lines.push('');
    lines.push(`### [${finding.severity.toUpperCase()}] ${escapeMarkdown(finding.title)}`);
    lines.push('');
    lines.push(`- Location: \`${location(finding).replace(/`/g, '')}\``);
    lines.push(`- Verification: **${VERIFICATION_LABEL[finding.verification]}** — ${escapeMarkdown(finding.verificationNote)}`);
    if (finding.attribution && finding.attribution !== 'unknown') {
      lines.push(`- Attribution: ${finding.attribution}`);
    }
    lines.push(`- Rule: \`${finding.ruleId}\` (${finding.origin})`);
    lines.push('');
    lines.push(escapeMarkdown(finding.description));
    if (finding.suggestedFix) {
      lines.push('');
      lines.push(`**Suggested fix:** ${escapeMarkdown(finding.suggestedFix)}`);
    }
    const evidence = finding.evidence.map((ref) => evidenceById.get(ref.evidenceId)).filter((e): e is Evidence => e !== undefined);
    if (evidence.length > 0) {
      lines.push('');
      lines.push('**Evidence**');
      lines.push('');
      evidence.forEach((e) => lines.push(evidenceBlock(e)));
    }
  }

  if (result.aiSummary) {
    lines.push('');
    lines.push(`## AI walkthrough (${escapeMarkdown(result.aiSummary.author)})`);
    lines.push('');
    lines.push(...walkthrough(result.aiSummary));
  }

  if (result.aiRuns.length > 0) {
    lines.push('');
    lines.push('## AI review');
    for (const run of result.aiRuns) {
      lines.push('');
      lines.push(`- ${escapeMarkdown(run.providerId)} (${escapeMarkdown(run.model)}) at ${run.startedAt}: ${run.accepted} finding(s) accepted, ${run.rejected} rejected. Files shared: ${run.filesShared.length}.`);
      run.rejectionReasons.slice(0, 10).forEach((r) => lines.push(`  - Rejected: ${escapeMarkdown(r)}`));
    }
  }

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push('## Files not analyzed');
    lines.push('');
    result.skipped.slice(0, 200).forEach((s) => lines.push(`- \`${s.path.replace(/`/g, '')}\` — ${escapeMarkdown(s.reason)}`));
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Generated by Probato PR (ArmoTuSitio). AI and static findings are not proof; only executed checks count as verification._');
  lines.push('');
  return lines.join('\n');
}

const DESCRIPTION_FINDINGS = 10;

function walkthrough(summary: AiSummary): string[] {
  const lines = [escapeMarkdown(summary.overview)];
  if (summary.changes.length > 0) {
    lines.push('', ...summary.changes.map((c) => `- \`${c.file.replace(/`/g, '')}\`: ${escapeMarkdown(c.summary)}`));
  }
  if (summary.reviewFocus.length > 0) {
    lines.push('', '**Where to look first**', '', ...summary.reviewFocus.map((f) => `- ${escapeMarkdown(f)}`));
  }
  return lines;
}

/**
 * Compact Markdown for a pull request description: the AI walkthrough when there is one, then what
 * Probato PR verified. Works without AI. Repository-controlled text is escaped like the full report.
 */
export function renderPullRequestDescription(result: ReviewResult): string {
  const { risk } = result;
  const v = risk.counts.byVerification;
  const lines: string[] = [];
  if (result.aiSummary) {
    lines.push('## Summary', '', ...walkthrough(result.aiSummary), '');
  }
  lines.push('## Verification (Probato PR)', '');
  lines.push(`**Review risk: ${risk.level.toUpperCase()}** · ${result.stats.filesChanged} file(s), +${result.stats.additions} / -${result.stats.deletions}`);
  lines.push('');
  lines.push(`Findings: ${v.confirmed} confirmed · ${v.evidenced} evidenced · ${v.suspected} suspected · ${v['not-verified']} not verified`);
  if (result.checks.length > 0) {
    lines.push('');
    result.checks.forEach((c) => lines.push(`- \`${c.commandLine.replace(/`/g, "'")}\`: ${CHECK_ICON[c.status]}${c.attribution !== 'unknown' ? ` (${c.attribution})` : ''}`));
  } else {
    lines.push('', 'No project checks were executed.');
  }
  const top = [...result.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)).slice(0, DESCRIPTION_FINDINGS);
  if (top.length > 0) {
    lines.push('', '### Findings', '');
    top.forEach((f) => lines.push(`- **${f.severity.toUpperCase()}** · ${VERIFICATION_LABEL[f.verification]} · ${escapeMarkdown(f.title)} (\`${location(f).replace(/`/g, '')}\`)`));
    if (result.findings.length > top.length) {
      lines.push(`- …and ${result.findings.length - top.length} more in the full report.`);
    }
  }
  lines.push('', '<sub>Generated by Probato PR. Only executed checks count as proof; AI and static findings are not.</sub>', '');
  return lines.join('\n');
}
