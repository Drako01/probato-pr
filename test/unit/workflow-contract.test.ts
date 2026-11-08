import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the CI/publish split: PRs are validated by ci.yml (required checks), publish.yml never runs on PRs and
// publishes one checksummed VSIX. Text checks only, so no YAML dependency is needed.
const read = (file: string): string => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
const ci = read('ci.yml'), publish = read('publish.yml');
const triggers = (workflow: string): string => /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(workflow)?.[1] ?? '';

describe('workflow contract', () => {
  it('ci.yml validates pull requests with the required check names of the main ruleset', () => {
    expect(triggers(ci)).toMatch(/^ {2}pull_request:/m);
    expect(triggers(ci)).toMatch(/^ {2}merge_group:/m);
    expect(triggers(ci)).not.toMatch(/^ {2}push:/m);
    expect(ci).toContain('name: Verify (${{ matrix.os }})');
    expect(ci).toContain('os: [ubuntu-latest, windows-latest, macos-latest]');
    expect(ci).not.toMatch(/id-token: write|contents: write|environment:/);
  });

  it('publish.yml never runs on pull requests and does not repeat the PR matrix', () => {
    expect(triggers(publish)).not.toMatch(/pull_request/);
    expect(triggers(publish)).toMatch(/^ {2}push:/m);
    expect(publish).not.toContain('Verify (${{ matrix.os }})');
    expect(publish).toContain('cancel-in-progress: false');
  });

  it('publishes a single VSIX whose SHA-256 is checked by every consumer', () => {
    expect(publish.match(/vsce package/g)).toHaveLength(1);
    const downloads = publish.match(/actions\/download-artifact@/g)?.length ?? 0;
    expect(downloads).toBeGreaterThan(0);
    expect(publish.match(/sha256sum -c probato-pr\.vsix\.sha256/g)).toHaveLength(downloads);
  });

  it('pins every action to a full commit SHA', () => {
    for (const workflow of [ci, publish]) {
      for (const [, ref] of workflow.matchAll(/uses: [\w.-]+\/[\w.-]+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
