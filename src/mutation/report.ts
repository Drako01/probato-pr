import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tr } from '../core/i18n';
import type { MutationMetrics, MutationRecord, MutationStatus } from './model';

const position = z.object({ line: z.number().int().positive(), column: z.number().int().positive() });
const mutant = z.object({ id: z.string().max(200), mutatorName: z.string().max(200), replacement: z.string().max(100_000), status: z.string().max(100), statusReason: z.string().max(10_000).optional(), location: z.object({ start: position, end: position }) });
const ReportSchema = z.object({ schemaVersion: z.string().max(100), files: z.record(z.string(), z.object({ source: z.string().max(2_000_000), mutants: z.array(mutant).max(100_000) })) });
const STATUS: Readonly<Record<string, MutationStatus>> = { Killed: 'KILLED', Survived: 'SURVIVED', NoCoverage: 'NO_COVERAGE', Timeout: 'TIMED_OUT', CompileError: 'COMPILE_ERROR', RuntimeError: 'RUNTIME_ERROR', Ignored: 'IGNORED', Pending: 'NOT_RUN' };
export function mutationHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function offset(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  if (line > lines.length || column - 1 > (lines[line - 1]?.length ?? 0)) throw new Error(tr('Mutation report contains an invalid source location.'));
  return lines.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0) + column - 1;
}
export function mutationMetrics(mutants: readonly MutationRecord[]): MutationMetrics {
  const counts: Record<MutationStatus, number> = { KILLED: 0, SURVIVED: 0, NO_COVERAGE: 0, TIMED_OUT: 0, COMPILE_ERROR: 0, RUNTIME_ERROR: 0, IGNORED: 0, NOT_RUN: 0 };
  for (const item of mutants) counts[item.status]++;
  const detected = counts.KILLED + counts.TIMED_OUT, undetected = counts.SURVIVED + counts.NO_COVERAGE, evaluated = detected + undetected;
  return { counts, detected, undetected, evaluated, ...(evaluated ? { mutationScore: detected / evaluated * 100, killedOnlyScore: counts.KILLED / evaluated * 100 } : {}) };
}
export interface ParsedMutationReport { readonly schemaVersion: string; readonly metrics: MutationMetrics; readonly mutants: readonly MutationRecord[]; readonly sourceHash: string }
/** Normalizes the published Stryker report schema; raw statuses and original code remain available. */
export function parseStrykerReport(raw: unknown, impactedFiles?: readonly string[]): ParsedMutationReport {
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) throw new Error(tr('Stryker returned an invalid mutation report.'));
  const records: MutationRecord[] = [], sources: [string, string][] = [];
  const occurrences = new Map<string, number>();
  for (const [rawFile, entry] of Object.entries(parsed.data.files).sort(([a], [b]) => a.localeCompare(b))) {
    const file = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!file || file.startsWith('/') || file.includes(':') || file.split('/').includes('..') || (impactedFiles && !impactedFiles.includes(file))) throw new Error(tr('Mutation report contains a file outside the authorized impact: {0}.', file));
    const source = entry.source.replace(/\r\n/g, '\n');
    sources.push([file, source]);
    for (const item of entry.mutants) {
      const start = offset(source, item.location.start.line, item.location.start.column), end = offset(source, item.location.end.line, item.location.end.column);
      if (end < start) throw new Error(tr('Mutation report contains an invalid source location.'));
      const original = source.slice(start, end);
      const context = source.split('\n')[item.location.start.line - 1]?.trim() ?? '';
      const semantic = mutationHash(JSON.stringify([file, item.mutatorName, item.replacement, original, context]));
      const occurrence = occurrences.get(semantic) ?? 0; occurrences.set(semantic, occurrence + 1);
      const status = STATUS[item.status] ?? 'NOT_RUN';
      records.push({ id: item.id, identity: `${semantic}:${occurrence}`, file, line: item.location.start.line, column: item.location.start.column,
        mutatorName: item.mutatorName, replacement: item.replacement, original, rawStatus: item.status, status, attribution: 'UNKNOWN',
        ...(item.statusReason ? { reason: item.statusReason } : {}) });
    }
  }
  return { schemaVersion: parsed.data.schemaVersion, metrics: mutationMetrics(records), mutants: records, sourceHash: mutationHash(JSON.stringify(sources)) };
}
