import type { Analyzer, AnalyzerContext, AnalyzerOutput } from '../core/analyzer';
import { sha256 } from '../core/ids';

const MAX_FILES = 25_000;
const MAX_INPUT_CHARS = 32_000_000;
const MAX_OUTPUT_CHARS = 20_000_000;

interface Snapshot {
  readonly key: string;
  readonly context: AnalyzerContext;
}

/** Memory-only LRU. Reuse requires identical changed sides AND the entire consumer/config workspace. */
export class ReviewCache {
  private readonly entries = new Map<string, { readonly output: AnalyzerOutput; readonly size: number }>();
  private snapshots = new WeakMap<AnalyzerContext['changes'], Promise<Snapshot | undefined>>();
  private size = 0;

  clear(): void { this.entries.clear(); this.size = 0; this.snapshots = new WeakMap(); }

  invalidateSnapshot(changes: AnalyzerContext['changes']): void { this.snapshots.delete(changes); }

  async run(analyzer: Analyzer, context: AnalyzerContext, version: string, shareSnapshot = false): Promise<AnalyzerOutput> {
    let pending = shareSnapshot ? this.snapshots.get(context.changes) : undefined;
    if (!pending) {
      pending = this.snapshot(context);
      if (shareSnapshot) { this.snapshots.set(context.changes, pending); }
    }
    const snapshot = await pending;
    if (!snapshot || context.signal?.aborted) { return analyzer.analyze(context); }
    const key = sha256(JSON.stringify([version, analyzer.id, snapshot.key]));
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return structuredClone(cached.output);
    }
    const output = await analyzer.analyze({ ...snapshot.context, ...(context.signal ? { signal: context.signal } : {}) });
    if (!context.signal?.aborted) {
      const size = JSON.stringify(output).length;
      if (size <= MAX_OUTPUT_CHARS) {
        while ((this.entries.size >= 64 || this.size + size > MAX_OUTPUT_CHARS) && this.entries.size > 0) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) { break; }
          this.size -= this.entries.get(oldest)?.size ?? 0; this.entries.delete(oldest);
        }
        this.entries.set(key, { output: structuredClone(output), size }); this.size += size;
      }
    }
    return output;
  }

  private async snapshot(context: AnalyzerContext): Promise<Snapshot | undefined> {
    const files = [...await context.workspace.listFiles(() => true)].sort();
    if (files.length > MAX_FILES) { return undefined; }
    const head = new Map<string, string | undefined>();
    const base = new Map<string, string | undefined>();
    let size = 0;
    for (const file of files) {
      if (context.signal?.aborted) { return undefined; }
      const text = await context.workspace.read(file); head.set(file, text); size += text?.length ?? 0;
      if (size > MAX_INPUT_CHARS) { return undefined; }
    }
    for (const file of context.changes.files) {
      const before = await context.changes.content.read(file.path, 'base');
      const after = await context.changes.content.read(file.path, 'head');
      base.set(file.path, before); head.set(file.path, after); size += (before?.length ?? 0) + (after?.length ?? 0);
      if (size > MAX_INPUT_CHARS) { return undefined; }
    }
    const key = sha256(JSON.stringify([context.changes.scope, context.changes.repository, context.changes.files, context.changes.skipped, [...base], [...head]]));
    return {
      key,
      context: {
        changes: { ...context.changes, content: { read: (file, side) => Promise.resolve((side === 'base' ? base : head).get(file)) } },
        workspace: { listFiles: (filter) => Promise.resolve(files.filter(filter)), read: (file) => Promise.resolve(head.get(file)) },
      },
    };
  }
}

export function withIncrementalCache(analyzers: readonly Analyzer[], version: string, cache = new ReviewCache()): Analyzer[] {
  // ReviewEngine calls appliesTo for every analyzer in order, including those that are skipped.
  // Seeing an analyzer for the second time marks a fresh pass even if a caller reused the ChangeSet.
  let active: AnalyzerContext['changes'] | undefined;
  const checked = new Set<string>();
  return analyzers.map((analyzer) => ({
    id: analyzer.id, description: analyzer.description,
    appliesTo: (changes) => {
      if (active !== changes || checked.has(analyzer.id)) {
        cache.invalidateSnapshot(changes); active = changes; checked.clear();
      }
      checked.add(analyzer.id);
      return analyzer.appliesTo(changes);
    },
    analyze: (context) => cache.run(analyzer, context, version, true),
  }));
}
