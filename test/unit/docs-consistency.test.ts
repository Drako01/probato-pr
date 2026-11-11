import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Lightweight guard: the security/privacy documents must describe every external write the code performs.
const read = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const security = read('SECURITY.md'), privacy = read('PRIVACY.md'), delivery = read('src/github/delivery.ts'), localDelivery = read('src/git/local-delivery.ts');

// GitHubDelivery write method -> phrase that SECURITY.md must contain.
const GITHUB_WRITES: Readonly<Record<string, string>> = {
  createOrUpdate: 'Create or Update Pull Request',
  setDraft: 'toggles draft state',
  publishReview: 'Publish Selected Findings',
  publishAnalysis: 'Publish Full Analysis to GitHub',
  review: 'REQUEST_CHANGES',
  reply: 'Replies to review comments',
  resolve: 'resolves or unresolves threads',
  merge: 'Merges the expected head commit',
  enqueue: 'merge queue',
};

describe('documentation matches implemented permissions', () => {
  it('documents every GitHub write implemented by the delivery adapter', () => {
    for (const [method, phrase] of Object.entries(GITHUB_WRITES)) {
      expect(delivery, `GitHubDelivery.${method} no longer exists: update this guard`).toMatch(new RegExp(`async ${method}\\(`));
      expect(security, `SECURITY.md must document ${method}`).toContain(phrase);
    }
    expect(privacy).toContain('GitHub delivery');
  });

  it('documents local Git writes', () => {
    for (const [command, phrase] of [['commit', 'commit'], ['push', 'push'], ['switch', 'switch branch']] as const) {
      expect(localDelivery).toContain(`'${command}'`);
      expect(security).toContain(phrase);
    }
  });

  it('does not reintroduce known false claims', () => {
    expect(security).not.toMatch(/never posts comments or changes anything on GitHub/i);
    expect(security).not.toMatch(/shows the exact commands and script bodies/i);
    expect(read('docs/MANUAL_TEST_PLAN.md')).not.toMatch(/with the script body and/i);
  });
});
