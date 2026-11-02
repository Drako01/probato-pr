import { afterEach, describe, expect, it } from 'vitest';
import { staticFinding } from '../../src/core/finding-factory';
import { formatMessage, msg, setTranslator } from '../../src/core/i18n';
import { assessRisk } from '../../src/core/risk';
import { renderMarkdown } from '../../src/reports/markdown';

const SPANISH: Record<string, string> = {
  'Empty catch block in {0}': 'Bloque catch vacío en {0}',
  'No verification commands were executed; findings rely on static analysis only.': 'No se ejecutó ningún comando de verificación.',
};

function emptyCatch() {
  return staticFinding({
    analyzerId: 'error-handling',
    ruleId: 'errors/empty-catch',
    severity: 'medium',
    verification: 'evidenced',
    verificationNote: msg('note'),
    title: msg('Empty catch block in {0}', 'src/a.ts'),
    description: msg('description'),
    location: { file: 'src/a.ts', startLine: 3 },
    evidenceDescription: msg('Line {0}: {1}', 3, 'catch {}'),
  });
}

describe('engine messages', () => {
  afterEach(() => {
    setTranslator(undefined);
  });

  it('fills placeholders by index and leaves unknown ones intact', () => {
    expect(formatMessage('{1} then {0}, {2}', ['a', 7])).toBe('7 then a, {2}');
  });

  it('renders findings in the active locale while keeping the id of the English title', () => {
    const english = emptyCatch().finding;
    setTranslator((template, ...args) => formatMessage(SPANISH[template] ?? template, args));
    const spanish = emptyCatch().finding;

    expect(english.title).toBe('Empty catch block in src/a.ts');
    expect(spanish.title).toBe('Bloque catch vacío en src/a.ts');
    expect(spanish.id).toBe(english.id);
  });

  it('renders report headings and state names in the active locale', () => {
    const spanish: Record<string, string> = { 'Why this risk level': 'Por qué este riesgo', Low: 'Bajo', 'Review risk: {0}': 'Riesgo de la revisión: {0}' };
    setTranslator((template, ...args) => formatMessage(spanish[template] ?? template, args));
    const risk = assessRisk({ findings: [], checks: [], analyzerRuns: [{ analyzerId: 'secrets', status: 'ran' }], skipped: [], scope: { kind: 'working', label: 'x', headIsWorkingTree: true } });
    const md = renderMarkdown({
      id: 'r',
      createdAt: '2026-11-02T00:00:00Z',
      toolVersion: '0.1.3',
      scope: { kind: 'working', label: 'x', headIsWorkingTree: true },
      repository: { name: 'repo', root: '/repo', branch: undefined, headSha: undefined },
      stats: { filesChanged: 0, filesSkipped: 0, additions: 0, deletions: 0 },
      changedFiles: [],
      skipped: [],
      findings: [],
      evidence: [],
      checks: [],
      analyzerRuns: [],
      aiRuns: [],
      risk,
    });
    expect(md).toContain('## Por qué este riesgo');
    expect(md).toContain('**Riesgo de la revisión: BAJO**');
  });

  it('localizes risk reasons and limitations', () => {
    setTranslator((template, ...args) => formatMessage(SPANISH[template] ?? template, args));
    const risk = assessRisk({ findings: [], checks: [], analyzerRuns: [], skipped: [], scope: { kind: 'working', label: 'Working tree', headIsWorkingTree: true } });
    expect(risk.limitations).toContain('No se ejecutó ningún comando de verificación.');
  });
});
