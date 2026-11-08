import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import spanish from '../../l10n/bundle.l10n.es.json';
import { formatMessage } from '../../src/core/i18n';
import { AnalyzerWorkerHost } from '../../src/infrastructure/analyzer-worker-host';
import { changeSetOf, tempDir, workspaceOf } from './helpers';

const sandbox = tempDir('probato-worker-');
const actualWorker = path.join(sandbox.dir, 'analyzer.cjs');
const busyWorker = path.join(sandbox.dir, 'busy.cjs');
const stoppedWorker = path.join(sandbox.dir, 'stopped.cjs');
const hungryWorker = path.join(sandbox.dir, 'hungry.cjs');
beforeAll(async () => {
  await build({ entryPoints: ['src/analyzer-worker.ts'], outfile: actualWorker, bundle: true, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent' });
  // Controlled CPU-bound test worker: a heartbeat on the calling thread must continue throughout this loop.
  await writeFile(busyWorker, `const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{if(m.type!=='review')return;const start=Date.now();while(Date.now()-start<200){}parentPort.postMessage({type:'result',reviewId:m.reviewId,result:{id:'busy-complete'}});});`);
  await writeFile(stoppedWorker, `process.exit(3);`);
  // Fault injection: unbounded allocation must hit the worker heap ceiling, never the calling process.
  await writeFile(hungryWorker, `const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{if(m.type!=='review')return;const hoard=[];for(;;)hoard.push(new Array(1e5).fill({k:hoard.length}));});`);
}, 30_000);
afterAll(() => { sandbox.cleanup(); });

const changes = () => changeSetOf([{ path: 'src/api.ts', base: 'export function load() {}', head: 'export function replacement() {}' }]);
const sources = () => workspaceOf({ 'src/api.ts': 'export function replacement() {}', 'src/client.ts': "import { load } from './api'; load();" });

describe('analysis outside the calling event loop', () => {
  it('keeps the caller responsive during CPU-bound worker execution', async () => {
    const host = new AnalyzerWorkerHost({ workerPath: busyWorker, version: 'test' });
    let beats = 0;
    const heartbeat = setInterval(() => { beats++; }, 5);
    try {
      const result = await host.review(changes(), sources());
      expect(result.id).toBe('busy-complete');
      expect(beats).toBeGreaterThanOrEqual(10);
    } finally { clearInterval(heartbeat); host.dispose(); }
  });

  it('runs real analyzers through exact content RPC and renders the worker locale', async () => {
    const host = new AnalyzerWorkerHost({ workerPath: actualWorker, version: 'test-worker', locale: 'es-AR' });
    const changeset = changes();
    const contentRead = vi.fn((file: string, side: 'base' | 'head') => changeset.content.read(file, side));
    const source = sources();
    const workspaceRead = vi.fn((file: string) => source.read(file));
    const progress = vi.fn();
    try {
      const result = await host.review({ ...changeset, content: { read: contentRead } }, { ...source, read: workspaceRead }, { progress });
      const finding = result.findings.find((candidate) => candidate.ruleId === 'contracts/export-removed');
      expect(finding?.title).toBe(formatMessage(spanish['"{0}" is no longer exported by {1}'], ['load', 'src/api.ts']));
      expect(result.toolVersion).toBe('test-worker');
      expect(result.performance?.analysisMs).toBeGreaterThan(0);
      expect(contentRead).toHaveBeenCalledWith('src/api.ts', 'base');
      expect(contentRead).toHaveBeenCalledWith('src/api.ts', 'head');
      expect(workspaceRead).toHaveBeenCalledWith('src/client.ts');
      expect(progress).toHaveBeenCalled();
      const repeated = await host.review(changes(), sources());
      expect(repeated.findings).toEqual(result.findings);
    } finally { host.dispose(); }
  });

  it('rejects concurrent reviews, cancels promptly and starts a fresh worker for the next review', async () => {
    const host = new AnalyzerWorkerHost({ workerPath: busyWorker, version: 'test' });
    const controller = new AbortController();
    try {
      const pending = host.review(changes(), sources(), { signal: controller.signal });
      await expect(host.review(changes(), sources())).rejects.toThrow(/already running/);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'CancelledError' });
      expect((await host.review(changes(), sources())).id).toBe('busy-complete');
    } finally { host.dispose(); }
  });

  it('does not report success when the worker exits or the analysis deadline expires', async () => {
    const stopped = new AnalyzerWorkerHost({ workerPath: stoppedWorker, version: 'test' });
    const timed = new AnalyzerWorkerHost({ workerPath: busyWorker, version: 'test', timeoutMs: 30 });
    try {
      await expect(stopped.review(changes(), sources())).rejects.toThrow(/stopped unexpectedly/);
      await expect(timed.review(changes(), sources())).rejects.toThrow(/time limit/);
    } finally { stopped.dispose(); timed.dispose(); }
  });

  it('fault injection: stops a worker at its memory limit and recovers with a fresh worker', async () => {
    const hungry = new AnalyzerWorkerHost({ workerPath: hungryWorker, version: 'test', memoryLimitMb: 32 });
    try {
      await expect(hungry.review(changes(), sources())).rejects.toThrow(/memory limit \(32 MB\)/);
    } finally { hungry.dispose(); }
    const healthy = new AnalyzerWorkerHost({ workerPath: busyWorker, version: 'test', memoryLimitMb: 32 });
    try { expect((await healthy.review(changes(), sources())).id).toBe('busy-complete'); } finally { healthy.dispose(); }
  }, 30_000);

  it('rejects reviews after disposal or when already cancelled without creating a worker', async () => {
    const host = new AnalyzerWorkerHost({ workerPath: 'missing-worker.cjs', version: 'test' });
    const controller = new AbortController(); controller.abort();
    await expect(host.review(changes(), sources(), { signal: controller.signal })).rejects.toMatchObject({ name: 'CancelledError' });
    host.dispose();
    await expect(host.review(changes(), sources())).rejects.toMatchObject({ name: 'CancelledError' });
  });
});
