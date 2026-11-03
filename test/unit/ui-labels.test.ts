import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import spanish from '../../l10n/bundle.l10n.es.json';
import { formatMessage, setTranslator } from '../../src/core/i18n';
import { checkKindLabel } from '../../src/core/labels';
import type { CommandEvidence } from '../../src/core/model';
import type { ReviewSession } from '../../src/extension/review-session';
import { EVIDENCE_SCHEME, ReviewDocuments } from '../../src/ui/documents';

vi.mock('vscode', async () => {
  const { formatMessage } = await import('../../src/core/i18n');
  const dictionary = (await import('../../l10n/bundle.l10n.es.json')).default as Record<string, string>;
  return {
    l10n: { t: (template: string, ...args: (string | number)[]) => formatMessage(dictionary[template] ?? template, args) },
    Uri: { from: (value: unknown) => value },
    EventEmitter: class { readonly event = () => ({ dispose: () => undefined }); fire() {} dispose() {} },
  };
});

const dictionary: Record<string, string> = spanish;
beforeEach(() => { setTranslator((template, ...args) => formatMessage(dictionary[template] ?? template, args)); });
afterEach(() => { setTranslator(undefined); });

describe('localized visible evidence and categories', () => {
  it('renders each check category in the active locale', () => {
    expect(['typecheck', 'lint', 'test', 'build', 'vet'].map((kind) => checkKindLabel(kind as Parameters<typeof checkKindLabel>[0])))
      .toEqual(['Comprobación de tipos', 'Lint', 'Tests', 'Compilación', 'Análisis de Go']);
  });

  it('localizes command evidence headings and domain states while preserving command data and output', () => {
    const rawOutput = 'Outcome: failed\nCommand: tool --head base\nraw error: unknown';
    const evidence: CommandEvidence = {
      kind: 'command-run', id: 'evidence-1', checkId: 'check-1', revision: 'head', commitSha: 'a'.repeat(40), dirty: true,
      commandLine: 'tool --head base', cwd: '', startedAt: '2026-11-03T12:00:00Z', durationMs: 1200,
      exitCode: 1, signal: 'SIGTERM', outcome: 'failed', outputExcerpt: rawOutput, outputTruncated: true,
      outputSha256: 'b'.repeat(64), errorMessage: 'raw error: unknown',
    };
    const session = { current: { evidence: [evidence] }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as ReviewSession;
    const documents = new ReviewDocuments(session);
    const content = documents.provideTextDocumentContent({ scheme: EVIDENCE_SCHEME, path: '/evidence-1.log' } as vscode.Uri);
    expect(content).toContain('Probato PR — evidencia de ejecución evidence-1');
    expect(content).toContain('Comando: tool --head base');
    expect(content).toContain('Directorio: (raíz del repositorio)');
    expect(content).toContain('Resultado: Fallido');
    expect(content).toContain('Código de salida: 1 (señal SIGTERM)');
    expect(content).toContain('fragmento truncado: solo la parte final');
    expect(content).toContain(evidence.commitSha);
    expect(content).toContain(evidence.outputSha256);
    expect(content.endsWith(rawOutput)).toBe(true);
    expect(content).not.toContain('Revision: head');
    documents.dispose();
  });
});
