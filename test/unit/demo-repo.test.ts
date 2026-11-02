// Guards docs/MANUAL_TEST_PLAN.md: the demo repository must produce exactly the advertised results.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDefaultAnalyzers } from '../../src/analyzers';
import { ReviewEngine } from '../../src/core/review-engine';
import { GitClient } from '../../src/git/git-client';
import { LocalChangeCollector } from '../../src/git/local-changes';
import { NodeProcessRunner } from '../../src/infrastructure/process-runner';
import { GitWorkspaceIndex } from '../../src/infrastructure/workspace-index';
import { detectChecks } from '../../src/verification/check-detector';
import { applyVerification } from '../../src/verification/evidence-linker';
import { VerificationEngine } from '../../src/verification/verification-engine';
import { readFile, access } from 'node:fs/promises';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir('probato-demo-test-');
afterAll(cleanup);

describe('demo repository (scripts/create-demo-repo.mjs)', () => {
  it('produces the findings and the introduced regression described in the manual test plan', async () => {
    const root = path.join(dir, 'demo');
    execFileSync(process.execPath, ['scripts/create-demo-repo.mjs', root], { stdio: 'ignore' });
    const runner = new NodeProcessRunner();
    const git = new GitClient(runner, { timeoutMs: 30_000, maxBytes: 10_000_000 });
    const changes = await new LocalChangeCollector(git).collect(root, { kind: 'working' }, { maxFiles: 100, maxDiffBytes: 5e6, maxFileBytes: 1e6, exclude: [] });
    const review = await new ReviewEngine(createDefaultAnalyzers(), 'demo').review(changes, new GitWorkspaceIndex(git, root, 1e6));
    expect(review.findings.map((f) => f.ruleId).sort()).toEqual([
      'contracts/export-removed',
      'errors/empty-catch',
      'secrets/aws-access-key',
      'tests/assertions-removed',
      'tests/focused',
    ]);

    const plan = await detectChecks({
      readText: (rel) => readFile(path.join(root, rel), 'utf8').catch(() => undefined),
      exists: (rel) => access(path.join(root, rel)).then(() => true, () => false),
    });
    const head = review.repository.headSha;
    const outcome = await new VerificationEngine(runner, git).run({
      repoRoot: root,
      approved: plan,
      baselineCommit: head,
      headSha: head,
      headDirty: true,
      timeoutMs: 120_000,
      maxOutputBytes: 100_000,
    });
    expect(outcome.checks.map((c) => [c.label, c.status, c.attribution])).toEqual([['npm run test', 'failed', 'introduced']]);
    expect(applyVerification(review, outcome).risk.level).toBe('critical');
  }, 180_000);
});
