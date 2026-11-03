import * as path from 'node:path';
import { matchesAnyGlob } from '../core/glob';
import { tr } from '../core/i18n';
import type { PlannedCheck } from '../core/model';
import type { RepositoryPolicy } from '../core/repository-policy';

export interface CheckRecommendation { readonly checkId: string; readonly reason: string; readonly confidence: 'high' | 'medium' | 'low' }
export interface CheckRecommendations { readonly recommendations: readonly CheckRecommendation[]; readonly fallback: boolean }
const GLOBAL_INPUT = /^(?:\.probato\.yml|package\.json|(?:pnpm-lock|pnpm-workspace)\.yaml|package-lock\.json|yarn\.lock|go\.(?:mod|sum|work)|Cargo\.(?:toml|lock)|composer\.(?:json|lock)|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|(?:settings|build)\.gradle(?:\.kts)?|tsconfig[^/]*\.json|eslint\.config\.[cm]?js|\.github\/)/;

/** Suggestions annotate the complete detected plan. They never approve, execute, or remove a check. */
export function recommendChecks(plan: readonly PlannedCheck[], changedFiles: readonly string[], policy?: RepositoryPolicy): CheckRecommendations {
  const known = new Set(plan.map((check) => check.id));
  const files = [...new Set(changedFiles.map((file) => file.replace(/\\/g, '/')))];
  const invalidPath = files.some((file) => file.startsWith('/') || file.includes(':') || file.split('/').includes('..'));
  const policyRules = policy?.checks?.recommendations ?? [];
  const unknownIds = policyRules.some((rule) => rule.checkIds.some((id) => !known.has(id)));
  const fallback = !files.length || invalidPath || unknownIds || files.some((file) => GLOBAL_INPUT.test(file));
  const recommendations = plan.map((check): CheckRecommendation => {
    if (fallback) return { checkId: check.id, confidence: 'low', reason: tr('Full-plan fallback: changed inputs or repository policy do not support a narrower recommendation.') };
    if (policyRules.some((rule) => rule.checkIds.includes(check.id) && files.some((file) => matchesAnyGlob(file, rule.paths)))) {
      return { checkId: check.id, confidence: 'high', reason: tr('Repository policy maps changed paths to this existing check. This is a recommendation, not proof of complete coverage.') };
    }
    const cwd = path.posix.normalize(check.cwd || '.').replace(/^\.\//, '');
    if (cwd === '.' || files.some((file) => file === cwd || file.startsWith(`${cwd}/`))) {
      return { checkId: check.id, confidence: 'medium', reason: tr('Changed files belong to this project. Dependencies between projects may require additional checks.') };
    }
    return { checkId: check.id, confidence: 'low', reason: tr('No direct path match was found. This check remains available because indirect dependencies may be affected.') };
  });
  const matched = recommendations.some((item) => item.confidence !== 'low');
  if (!fallback && !matched) return { fallback: true, recommendations: recommendations.map((item) => ({ ...item, reason: tr('No project impact could be established; keep the full check plan available.') })) };
  return { recommendations, fallback };
}
