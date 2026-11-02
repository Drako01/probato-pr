import { stableId } from '../core/ids';
import type { CheckResult, ReviewFinding, ReviewResult } from '../core/model';
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
      ? `Reported by "${check.label}" with this change and absent when the same command ran on the base revision.`
      : `Reported by "${check.label}" in a file changed by this review. No baseline run, so it may predate the change.`,
    origin: 'verification',
    title: `${diagnostic.code === 'go' ? '' : `${diagnostic.code}: `}${diagnostic.message}`.slice(0, 200),
    description: `${check.label} reported this error at ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}.`,
    location: { file: diagnostic.file, startLine: diagnostic.line },
    evidence: [{ evidenceId, summary: `${check.label} output (${check.status})` }],
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
      const evidence = [...finding.evidence, { evidenceId: headEvidenceId, summary: `${check.label} reports ${codes} at this line` }];
      const newOnes = hits.filter((h) => introduced.has(fingerprint(h)));
      if (diag.hasBaseline && newOnes.length > 0) {
        return {
          ...finding,
          evidence,
          verification: 'confirmed',
          attribution: 'introduced',
          verificationNote: `Confirmed: "${check.label}" reports ${codes} at this location with this change, and not on the base revision.`,
        };
      }
      if (diag.hasBaseline && hits.every((h) => preExisting.has(fingerprint(h)))) {
        return {
          ...finding,
          evidence,
          verification: finding.verification === 'suspected' ? 'evidenced' : finding.verification,
          attribution: 'pre-existing',
          verificationNote: `${finding.verificationNote} "${check.label}" reports ${codes} here on the base revision too, so this error predates the change.`,
        };
      }
      return {
        ...finding,
        evidence,
        verification: finding.verification === 'suspected' || finding.verification === 'not-verified' ? 'evidenced' : finding.verification,
        verificationNote: `${finding.verificationNote} "${check.label}" reports ${codes} at this line (no baseline comparison, so attribution is unknown).`,
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
            verificationNote: `${f.verificationNote} However, "${passedTypecheck.label}" passed, so this may be a false positive (for example a path alias, or a file outside the compiled project).`,
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
