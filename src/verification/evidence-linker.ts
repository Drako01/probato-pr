import { stableId } from '../core/ids';
import type { CheckResult, ReviewFinding, ReviewResult } from '../core/model';
import { tr } from '../core/i18n';
import { finalizeResult } from '../core/review-engine';
import { fingerprint, type ToolDiagnostic } from './diagnostics-parser';
import type { VerificationOutcome } from './verification-engine';

const MAX_DIAGNOSTIC_FINDINGS_PER_CHECK = 100;
const CONTRACT_RULE = /^contracts\//;

function diagnosticFinding(
  check: CheckResult,
  diagnostic: ToolDiagnostic,
  evidenceId: string,
  mode: 'introduced' | 'unattributed',
): ReviewFinding {
  const introduced = mode === 'introduced';
  return {
    id: stableId('verification', check.checkId, diagnostic.file, diagnostic.code, diagnostic.message),
    ruleId: `verification/${check.kind}`,
    severity: introduced ? 'high' : 'medium',
    verification: introduced ? 'confirmed' : 'evidenced',
    verificationNote: introduced
      ? tr('Reported by "{0}" with this change and absent when the same command ran on the base revision.', check.label)
      : tr('Reported by "{0}" in a file changed by this review. No baseline run, so it may predate the change.', check.label),
    origin: 'verification',
    title: `${diagnostic.code === 'go' ? '' : `${diagnostic.code}: `}${diagnostic.message}`.slice(0, 200),
    description: tr('{0} reported this error at {1}:{2}:{3}.', check.label, diagnostic.file, diagnostic.line, diagnostic.column),
    location: { file: diagnostic.file, startLine: diagnostic.line },
    evidence: [{ evidenceId, summary: tr('{0} output ({1})', check.label, check.status) }],
    attribution: introduced ? 'introduced' : 'unknown',
  };
}

/**
 * Applies verification results to a review: links tool diagnostics to existing findings (upgrading
 * or downgrading their verification status with a stated reason), adds findings for new tool errors,
 * and records checks and command evidence. Always applied to the pre-verification review so repeated
 * runs replace, rather than stack, earlier verification.
 */
export function applyVerification(review: ReviewResult, outcome: VerificationOutcome): ReviewResult {
  const changed = new Set(review.changedFiles);
  let findings = review.findings.map((f) => ({ ...f }));
  const extra: ReviewFinding[] = [];

  for (const diag of outcome.diagnostics) {
    const check = outcome.checks.find((c) => c.checkId === diag.checkId);
    if (!check?.headEvidenceId) {
      continue;
    }
    const headEvidenceId = check.headEvidenceId;
    const introduced = new Set(diag.introduced.map(fingerprint));
    const preExisting = new Set(diag.preExisting.map(fingerprint));
    const matched = new Set<string>();

    findings = findings.map((finding) => {
      const hits = diag.head.filter((d) => d.file === finding.location.file && d.line >= finding.location.startLine && d.line <= (finding.location.endLine ?? finding.location.startLine));
      if (hits.length === 0) {
        return finding;
      }
      hits.forEach((h) => matched.add(fingerprint(h)));
      const codes = [...new Set(hits.map((h) => h.code))].join(', ');
      const evidence = [...finding.evidence, { evidenceId: headEvidenceId, summary: tr('{0} reports {1} at this line', check.label, codes) }];
      const newOnes = hits.filter((h) => introduced.has(fingerprint(h)));
      if (diag.hasBaseline && newOnes.length > 0) {
        return {
          ...finding,
          evidence,
          verification: 'confirmed',
          attribution: 'introduced',
          verificationNote:
            finding.origin === 'ai'
              ? tr('AI suspicion confirmed: "{0}" reports {1} at this location with this change, and not on the base revision.', check.label, codes)
              : tr('Confirmed: "{0}" reports {1} at this location with this change, and not on the base revision.', check.label, codes),
        };
      }
      if (diag.hasBaseline && hits.every((h) => preExisting.has(fingerprint(h)))) {
        return {
          ...finding,
          evidence,
          verification: finding.verification === 'suspected' ? 'evidenced' : finding.verification,
          attribution: 'pre-existing',
          verificationNote: `${finding.verificationNote} ${tr('"{0}" reports {1} here on the base revision too, so this error predates the change.', check.label, codes)}`,
        };
      }
      return {
        ...finding,
        evidence,
        verification: finding.verification === 'suspected' || finding.verification === 'not-verified' ? 'evidenced' : finding.verification,
        verificationNote: `${finding.verificationNote} ${tr('"{0}" reports {1} at this line (no baseline comparison, so attribution is unknown).', check.label, codes)}`,
      };
    });

    const unmatched = (diag.hasBaseline ? diag.introduced : diag.head.filter((d) => changed.has(d.file))).filter((d) => !matched.has(fingerprint(d)));
    for (const d of unmatched.slice(0, MAX_DIAGNOSTIC_FINDINGS_PER_CHECK)) {
      extra.push(diagnosticFinding(check, d, headEvidenceId, diag.hasBaseline ? 'introduced' : 'unattributed'));
    }
  }

  // A passing type-check contradicts static contract findings: downgrade them and say why.
  const passedTypecheck = outcome.checks.find((c) => c.kind === 'typecheck' && c.status === 'passed');
  if (passedTypecheck) {
    findings = findings.map((f) =>
      CONTRACT_RULE.test(f.ruleId) && f.verification === 'evidenced'
        ? {
            ...f,
            verification: 'suspected',
            verificationNote: `${f.verificationNote} ${tr('However, "{0}" passed, so this may be a false positive (for example a path alias, or a file outside the compiled project).', passedTypecheck.label)}`,
          }
        : f,
    );
  }

  return finalizeResult({
    ...review,
    findings: [...findings, ...extra],
    evidence: [...review.evidence, ...outcome.evidence],
    checks: outcome.checks,
  });
}
