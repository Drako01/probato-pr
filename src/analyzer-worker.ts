import { parentPort, workerData } from 'node:worker_threads';
import spanish from '../l10n/bundle.l10n.es.json';
import { createAnalyzers } from './analyzer-runtime';
import { formatMessage, setTranslator } from './core/i18n';
import { ReviewEngine } from './core/review-engine';
import type { ChangeSet } from './core/model';
import type { AnalyzerHostMessage, AnalyzerWorkerMessage, WorkerReadPayload } from './infrastructure/analyzer-worker-host';

const port = parentPort;
if (!port) throw new Error('The analyzer worker needs a parent message port.');
const data = workerData as { version: string; locale: string };
const dictionary: Record<string, string> = spanish;
setTranslator((template, ...args) => formatMessage(data.locale.toLowerCase().startsWith('es') ? dictionary[template] ?? template : template, args));
const engine = new ReviewEngine(createAnalyzers(data.version), data.version);
let requestSequence = 0;
let running = false;
const pending = new Map<number, { resolve: (value: string | readonly string[] | undefined) => void; reject: (error: Error) => void }>();
function send(message: AnalyzerWorkerMessage): void { port?.postMessage(message); }
function read(request: WorkerReadPayload): Promise<string | readonly string[] | undefined> {
  const requestId = ++requestSequence;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ ...request, type: 'read', requestId });
  });
}
port.on('message', (message: AnalyzerHostMessage) => {
  if (message.type === 'read-result') {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.ok) request.resolve(message.value); else request.reject(new Error(message.error));
    return;
  }
  if (running) return;
  running = true;
  const reviewId = message.reviewId;
  const changes: ChangeSet = {
    ...message.changes,
    content: { read: async (path, side) => {
      const value = await read({ reviewId, operation: 'content', path, side });
      return typeof value === 'string' ? value : undefined;
    } },
  };
  void engine.review(changes, {
    listFiles: async (filter) => {
      const value = await read({ reviewId, operation: 'list' });
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').filter(filter) : [];
    },
    read: async (path) => {
      const value = await read({ reviewId, operation: 'workspace', path });
      return typeof value === 'string' ? value : undefined;
    },
  }, { progress: (text) => { send({ type: 'progress', reviewId, message: text }); } }).then(
    (result) => { send({ type: 'result', reviewId, result }); },
    (error: unknown) => { send({ type: 'error', reviewId, message: error instanceof Error ? error.message : String(error) }); },
  ).finally(() => { running = false; pending.clear(); });
});
