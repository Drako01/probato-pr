import { describe, expect, it } from 'vitest';
import { parseHomeSetting } from '../../src/extension/home-settings';

describe('control center settings boundary', () => {
  it.each([
    ['review.onSave', true],
    ['review.baseBranch', ' main '],
    ['review.maxFiles', 5000],
    ['verification.baseline', 'always'],
    ['verification.timeoutSeconds', 5],
    ['ai.provider', 'vscode-lm'],
    ['ai.includeFileContent', false],
    ['home.openOnStartup', false],
  ])('accepts an allowed %s setting and explicit target', (key, value) => {
    expect(parseHomeSetting({ key, value, target: 'user' })).toEqual({ key, value: key === 'review.baseBranch' ? 'main' : value, target: 'user' });
    expect(parseHomeSetting({ key, value, target: 'workspace' })).toBeDefined();
  });

  it.each([
    ['review.onSave', 'true'], ['review.maxFiles', 0], ['review.maxFiles', 5001], ['review.maxFiles', 1.5],
    ['verification.timeoutSeconds', 4], ['verification.timeoutSeconds', 7201], ['verification.timeoutSeconds', NaN],
    ['verification.baseline', 'auto'], ['ai.provider', 'unknown'], ['ai.includeFileContent', 1],
    ['review.baseBranch', 'x'.repeat(201)], ['review.baseBranch', 'main\nother'], ['review.baseBranch', 'ma\0in'],
    ['home.openOnStartup', null], ['ai.openaiCompatible.baseUrl', 'https://example.test'],
    ['verification.checks', ['sh']], ['__proto__', {}], ['constructor', 'x'], ['prototype', true],
  ])('rejects invalid or unauthorized %s values', (key, value) => {
    expect(parseHomeSetting({ key, value, target: 'user' })).toBeUndefined();
  });

  it('requires an exact, explicit target and message shape', () => {
    const valid = { key: 'review.onSave', value: true, target: 'user' };
    for (const raw of [undefined, null, [], 'value', {}, { ...valid, target: 'folder' }, { ...valid, target: 1 }, { key: valid.key, value: true }, { ...valid, command: 'execute' }]) {
      expect(parseHomeSetting(raw)).toBeUndefined();
    }
  });

  it('rejects inherited or accessor fields without invoking them', () => {
    let invoked = false;
    const accessor = { key: 'review.onSave', target: 'user', get value() { invoked = true; return true; } };
    expect(parseHomeSetting(accessor)).toBeUndefined();
    expect(invoked).toBe(false);
    const inherited: unknown = Object.create({ key: 'review.onSave', value: true, target: 'user' });
    expect(parseHomeSetting(inherited)).toBeUndefined();
  });
});
