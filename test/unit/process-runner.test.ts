import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeProcessRunner, toSpawnInvocation, UnsafeCommandError } from '../../src/infrastructure/process-runner';
import { tempDir } from './helpers';

const runner = new NodeProcessRunner();
const base = { cwd: process.cwd(), timeoutMs: 20_000, maxOutputBytes: 100_000, capture: 'tail' as const };
const node = (code: string) => ({ executable: process.execPath, args: ['-e', code] });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe('NodeProcessRunner', () => {
  it('captures exit code and combined output', async () => {
    const result = await runner.run(node("console.log('out'); console.error('err'); process.exit(3)"), base);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs non-interactively (CI=1, no color)', async () => {
    const result = await runner.run(node('console.log(process.env.CI, process.env.NO_COLOR)'), base);
    expect(result.output.trim()).toBe('1 1');
  });

  it('kills a process that exceeds its timeout', async () => {
    const result = await runner.run(node('setTimeout(() => {}, 60000)'), { ...base, timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('cancellation kills the whole process tree (no orphaned grandchildren)', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const pidFile = path.join(dir, 'grandchild.pid');
      const script = `
        const { spawn } = require('node:child_process');
        const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
        setTimeout(() => {}, 60000);`;
      const controller = new AbortController();
      const pending = runner.run(node(script), { ...base, signal: controller.signal });
      expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(isAlive(grandchild)).toBe(true);
      controller.abort();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(await waitFor(() => !isAlive(grandchild), 8_000)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('keeps only the tail of large output and marks it truncated', async () => {
    const result = await runner.run(node("process.stdout.write('x'.repeat(200000) + 'END')"), { ...base, maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(1000);
    expect(result.output.endsWith('END')).toBe(true);
  });

  it('aborts full-capture commands whose output exceeds the limit', async () => {
    const result = await runner.run(node("process.stdout.write('y'.repeat(500000))"), { ...base, capture: 'full', maxOutputBytes: 10_000 });
    expect(result.truncated).toBe(true);
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runner.run({ executable: 'probato-definitely-missing-tool', args: [] }, base);
    expect(result.spawnError).toMatch(/ENOENT/);
  });

  it('does not start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run(node('process.exit(0)'), { ...base, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});

describe('toSpawnInvocation', () => {
  it('routes Windows package-manager shims through cmd.exe with validated arguments', () => {
    expect(toSpawnInvocation({ executable: 'npm', args: ['run', 'test:unit'] }, 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', 'npm', 'run', 'test:unit'],
    });
  });

  it.each(['test & calc', 'a|b', '%PATH%', 'x"y', 'a^b', '$(id)'])('rejects shell metacharacters on Windows: %s', (arg) => {
    expect(() => toSpawnInvocation({ executable: 'pnpm', args: ['run', arg] }, 'win32')).toThrow(UnsafeCommandError);
  });

  it('spawns directly (no shell) elsewhere', () => {
    expect(toSpawnInvocation({ executable: 'npm', args: ['run', 'a & b'] }, 'linux')).toEqual({ file: 'npm', args: ['run', 'a & b'] });
  });
});
