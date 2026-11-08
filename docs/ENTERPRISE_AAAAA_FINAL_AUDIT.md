# Enterprise AAAAA upgrade — re-audit (interim)

Same 100-point rubric as the 2026-11-08 audit. This is an engineering judgment, not a certification. Interim: Phase I
is complete (I.1–I.6 PASS; SARIF now validated against the official OASIS schema, gate decision recorded in reports,
E11) and part of Phases III, IV and V are implemented on `feat/enterprise-aaaaa-upgrade` (PR #16). Phases II and VI are
not done. Evidence IDs refer to [ENTERPRISE_AAAAA_TEST_EVIDENCE.md](ENTERPRISE_AAAAA_TEST_EVIDENCE.md).

| Axis | Before | Now | Evidence / deductions |
|---|---:|---:|---|
| Architecture | 13/15 | 13/15 | Gate logic is a pure domain module; the large controllers are unchanged (III.1 TODO). |
| Maintainability | 12/15 | 12/15 | No refactor of concentrated modules yet. |
| Security / supply chain | 11/15 | 12/15 | +1 truthful permission documentation guarded by a test (E2). Dependabot alert triaged as dev-only WARN (E9). No sandbox, adversarial suite, SBOM or provenance attestation yet. |
| Detector accuracy | 13/20 | 14/20 | +1 SARIF no longer inflates quality issues into vulnerabilities and is schema-valid (E11); differential gate respects attribution and evidence. No external benchmark (II.2 BLOCKED), which caps this axis. The Phase II harness (sealed holdout, per-rule Wilson CIs, 71 authored cases, E12) improves measurement but not external evidence, so the score is unchanged. |
| Testing / evidence | 12/15 | 13/15 | +1 per-module coverage measured and ratcheted (E6: `git` and `mutation` branches below 80%, WARN), seeded property tests (E8). No fault-injection suite additions, no cross-OS Extension Host. |
| CI/CD and releases | 8/10 | 9/10 | +1 PR validation split from publishing, no repeated QA on push(main), single checksummed VSIX, path-gated real mutation E2E (E5, first CI run in PR #16). −1: merge-candidate protection still depends on a post-merge release gate (ruleset not strict, V.2 BLOCKED); no provenance attestation. |
| Performance | 4/5 | 4/5 | Unchanged; no P50/P95 on real repositories. |
| UX / docs | 3/5 | 4/5 | +1 documentation contradictions removed; accessibility not audited. |
| **Total** | **76/100** | **81/100** | |

## Release verdict

**NO-GO for AAAAA** (target ≥95 is not demonstrated). Open blockers: external benchmark (P1-04, BLOCKED on licensed
labeled data), merge-candidate protection (V.2, needs maintainer ruleset decision), cross-OS Extension Host (P2-02),
threat model/red team/sandbox (Phase IV), controller refactors (III.1), accessibility audit and final screenshots
(Phase VI), coverage of `git`/`mutation` branches.
