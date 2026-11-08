import { Worker } from 'node:worker_threads';
import { asError } from '../core/errors';
import { tr } from '../core/i18n';
import type { WorkspaceIndex } from '../core/analyzer';
import type { ChangeSet, ReviewResult } from '../core/model';
import type { ProgressReporter } from '../core/review-engine';
import { CancelledError } from '../git/git-client';

export type SerializedChangeSet = Omit<ChangeSet, 'content'>;
export type WorkerReadRequest =
  | { readonly type: 'read'; readonly reviewId: number; readonly requestId: number; readonly operation: 'content'; readonly path: string; readonly side: 'base' | 'head' }
  | { readonly type: 'read'; readonly reviewId: number; readonly requestId: number; readonly operation: 'workspace'; readonly path: string }
  | { readonly type: 'read'; readonly reviewId: number; readonly requestId: number; readonly operation: 'list' };
type ReadPayload<T> = T extends unknown ? Omit<T, 'type' | 'requestId'> : never;
export type WorkerReadPayload = ReadPayload<WorkerReadRequest>;
export type AnalyzerWorkerMessage = WorkerReadRequest
  | { readonly type: 'progress'; readonly reviewId: number; readonly message: string }
  | { readonly type: 'result'; readonly reviewId: number; readonly result: ReviewResult }
  | { readonly type: 'error'; readonly reviewId: number; readonly message: string };
export type AnalyzerHostMessage =
  | { readonly type: 'review'; readonly reviewId: number; readonly changes: SerializedChangeSet }
  | { readonly type: 'read-result'; readonly reviewId: number; readonly requestId: number; readonly ok: true; readonly value: string | readonly string[] | undefined }
  | { readonly type: 'read-result'; readonly reviewId: number; readonly requestId: number; readonly ok: false; readonly error: string };

interface ActiveReview {
  readonly id: number;
  readonly changes: ChangeSet;
  readonly workspace: WorkspaceIndex;
  readonly resolve: (review: ReviewResult) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: ProgressReporter;
  readonly cleanup: () => void;
  bytes: number;
}
const MAX_RPC_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 100_000;
/** Heap ceiling of the analysis worker: a hostile or huge change set exhausts the worker, not the extension host. */
const DEFAULT_MEMORY_LIMIT_MB = 2048;

/** Analysis CPU runs outside the extension host. Source reads remain in the exact caller-provided snapshot. */
export class AnalyzerWorkerHost {
  private worker: Worker | undefined;
  private active: ActiveReview | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly options: { readonly workerPath: string; readonly version: string; readonly locale?: string; readonly timeoutMs?: number; readonly memoryLimitMb?: number }) {}

  review(changes: ChangeSet, workspace: WorkspaceIndex, options: { signal?: AbortSignal; progress?: ProgressReporter } = {}): Promise<ReviewResult> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(new CancelledError());
    if (this.active) return Promise.reject(new Error(tr('An analysis is already running. Cancel it before starting another review.')));
    const id = ++this.sequence;
    return new Promise<ReviewResult>((resolve, reject) => {
      const cancel = () => { this.stop(new CancelledError()); };
      const timer = setTimeout(() => { this.stop(new Error(tr('Analysis exceeded its time limit and was stopped. No successful result was produced.'))); }, this.options.timeoutMs ?? 180_000);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
      this.active = { id, changes, workspace, resolve, reject, cleanup, bytes: 0, ...(options.progress ? { progress: options.progress } : {}) };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        const worker = this.worker ?? this.createWorker();
        worker.ref();
        const serialized: SerializedChangeSet = { scope: changes.scope, repository: changes.repository, files: changes.files, skipped: changes.skipped };
        const message: AnalyzerHostMessage = { type: 'review', reviewId: id, changes: serialized };
        worker.postMessage(message);
      } catch (error) { this.stop(asError(error)); }
    });
  }

  private createWorker(): Worker {
    const memoryLimitMb = this.options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    const worker = new Worker(this.options.workerPath, {
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb },
      workerData: { version: this.options.version, locale: this.options.locale ?? 'en' },
    });
    this.worker = worker;
    worker.on('message', (message: AnalyzerWorkerMessage) => {
      void this.receive(worker, message).catch((error: unknown) => { if (this.worker === worker) this.stop(asError(error)); });
    });
    worker.on('error', (error: Error & { code?: string }) => {
      if (this.worker !== worker) return;
      this.stop(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? new Error(tr('The analysis worker exceeded its memory limit ({0} MB) and was stopped. No successful result was produced.', memoryLimitMb), { cause: error })
        : error);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      const active = this.active;
      this.active = undefined;
      if (active) { active.cleanup(); active.reject(new Error(tr('The analysis worker stopped unexpectedly (exit {0}). No successful result was produced.', code))); }
    });
    return worker;
  }

  private async receive(worker: Worker, message: AnalyzerWorkerMessage): Promise<void> {
    const active = this.active;
    if (worker !== this.worker || !active || message.reviewId !== active.id) return;
    if (message.type === 'progress') { active.progress?.(message.message); return; }
    if (message.type === 'result' || message.type === 'error') {
      this.active = undefined;
      active.cleanup(); worker.unref();
      if (message.type === 'result') active.resolve(message.result); else active.reject(new Error(message.message));
      return;
    }
    let response: AnalyzerHostMessage;
    try {
      if (active.bytes > MAX_RPC_BYTES) throw new Error(tr('Analysis source transfer exceeded its safe content budget.'));
      const value = message.operation === 'list'
        ? await active.workspace.listFiles(() => true)
        : message.operation === 'content'
          ? await active.changes.content.read(message.path, message.side)
          : await active.workspace.read(message.path);
      if (Array.isArray(value) && value.length > MAX_FILES) throw new Error(tr('Analysis source listing exceeded its safe file limit.'));
      active.bytes += value === undefined ? 0 : Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
      if (active.bytes > MAX_RPC_BYTES) throw new Error(tr('Analysis source transfer exceeded its safe content budget.'));
      response = { type: 'read-result', reviewId: active.id, requestId: message.requestId, ok: true, value };
    } catch (error) {
      response = { type: 'read-result', reviewId: active.id, requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.active?.id === active.id && this.worker === worker) worker.postMessage(response);
  }

  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    const active = this.active;
    this.active = undefined;
    active?.cleanup(); active?.reject(error);
    if (worker) void worker.terminate();
  }

  dispose(): void { this.disposed = true; this.stop(new CancelledError()); }
}
