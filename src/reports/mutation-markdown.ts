import { tr } from '../core/i18n';
import type { MutationResult } from '../mutation/model';
import { mutationStateLabel } from '../mutation/labels';

/** Four independent dimensions plus exact scope and provenance; mutant survival is never a confirmed defect. */
export function renderMutationMarkdown(result: MutationResult, escape: (text: string) => string): string[] {
  const lines = ['', `## ${tr('Mutation testing and differential quality gate')}`, '',
    `- ${tr('Execution: {0}', mutationStateLabel(result.execution.status))}`,
    `- ${tr('Verification result: {0}', mutationStateLabel(result.verification.status))}`,
    `- ${tr('Baseline comparability: {0}', mutationStateLabel(result.baseline.status))}`,
    `- ${tr('Quality trend: {0}', mutationStateLabel(result.quality.trend))}`,
    `- ${tr('Quality gate: {0}', mutationStateLabel(result.gate.decision))}`,
    `- ${tr('Impacted files: {0}', result.impactedFiles.length)}`,
    ...result.impactedFiles.map((file) => `  - ${escape(file)}`),
  ];
  if (result.quality.deltaPoints !== undefined) lines.push(`- ${tr('Mutation Score variation: {0} percentage points', result.quality.deltaPoints.toFixed(2))}`);
  lines.push('', ...[...new Set([...result.verification.reasons, ...result.baseline.reasons, ...result.quality.reasons, ...result.gate.reasons])].map((reason) => `- ${escape(reason)}`));
  for (const run of [result.base, result.head]) {
    if (!run) continue;
    lines.push('', `### ${tr('Mutation run: {0}', run.revision === 'base' ? tr('Base revision') : tr('Reviewed revision'))}`, '',
      `- ${tr('Evidence identifier: {0}', escape(run.id))}`,
      `- ${tr('Command: {0}', escape(run.commandLine))}`,
      `- ${tr('Started: {0}', run.startedAt)}`,
      `- ${tr('Finished: {0}', run.finishedAt)}`,
      `- ${tr('Output hash: {0}', run.outputSha256)}`);
    if (run.reportSha256) lines.push(`- ${tr('Report hash: {0}', run.reportSha256)}`);
    if (run.reproducibility) {
      const p = run.reproducibility;
      lines.push(`- ${tr('Commit: {0}', p.commit)}`, `- ${tr('Node: {0}; Stryker: {1}; runner: {2}', p.nodeVersion, p.strykerVersion, escape(p.runner))}`,
        `- ${tr('Source fingerprint: {0}', p.sourceHash)}`, `- ${tr('Dependencies fingerprint: {0}', p.dependencyHash)}`,
        `- ${tr('Configuration fingerprint: {0}', p.configurationHash)}`, `- ${tr('Execution conditions fingerprint: {0}', p.conditionsHash)}`);
      for (const [name, version] of Object.entries(p.dependencyVersions)) lines.push(`  - ${escape(name)}: ${escape(version)}`);
    }
    if (!run.report) continue;
    const metrics = run.report.metrics;
    lines.push('', `- ${tr('Reported mutants: {0}', run.report.mutants.length)}`);
    if (metrics.mutationScore !== undefined) lines.push(`- ${tr('Stryker Mutation Score: {0}%', metrics.mutationScore.toFixed(2))}`);
    if (metrics.killedOnlyScore !== undefined) lines.push(`- ${tr('Killed-only ratio (different metric): {0}%', metrics.killedOnlyScore.toFixed(2))}`);
    lines.push('', tr('Stryker counts killed mutants and mutant timeouts as detected. Compile errors, runtime errors and ignored or unrun mutants are not killed mutants. The killed-only ratio excludes timeouts from its numerator.'), '',
      `| ${tr('Mutant')} | ${tr('Location')} | ${tr('Normalized state')} | ${tr('Original state')} | ${tr('Attribution')} |`, '|---|---|---|---|---|');
    for (const mutant of run.report.mutants.slice(0, 200)) lines.push(`| ${escape(mutant.id)} | ${escape(mutant.file)}:${mutant.line} | ${mutationStateLabel(mutant.status)} | ${escape(mutant.rawStatus)} | ${mutationStateLabel(mutant.attribution)} |`);
    if (run.report.mutants.length > 200) lines.push('', tr('Only the first 200 mutants are shown here. The JSON report retains the full bounded result.'));
  }
  return lines;
}
